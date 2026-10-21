import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { BrowserAutomation } from './adapters/browser.js';
import { AsideWorkflow, type Workflow, type PublishInput } from './adapters/aside-workflow.js';
import { parseCommand, validateResultUrl } from './validation.js';
import type { AppState, Job, Product } from './shared.js';

export type ProductBrowser = Pick<BrowserAutomation, 'open' | 'scanProducts' | 'issueLink' | 'verifyProduct'>;
export class AppController {
  private busy = false;
  constructor(private readonly store: Store, private readonly workflow: Workflow = new AsideWorkflow(),
    private readonly browserFor: (workTabs: boolean) => ProductBrowser = flag => new BrowserAutomation(undefined, flag),
    private readonly openExternal: (url: string) => Promise<unknown> = async () => { throw new Error('외부 링크 열기가 연결되지 않았습니다.'); }) {}

  private product(id: string): Product {
    const product = this.store.state().products.find(p => p.id === id);
    if (!product) throw new Error('상품을 찾을 수 없습니다.');
    return product;
  }
  private publication(job: Job): PublishInput {
    const state = this.store.state();
    const draft = state.drafts.find(d => d.id === job.draftId);
    if (!draft || draft.version !== job.version) throw new Error('원고 버전이 바뀌었습니다. 원본 글을 직접 확인하세요.');
    return { requestId: job.id, draft, product: this.product(draft.productId), target: job.target,
      useWorkTabs: state.settings.useWorkTabs, onSession: id => this.store.bindAsideSession(job.id, id) };
  }
  private async runJob(id: string): Promise<void> {
    const job = this.store.claim(id);
    try {
      const input = this.publication(job);
      this.workflow.assertPublishable(input);
      await this.browserFor(input.useWorkTabs).verifyProduct(input.product);
      if (this.store.state().paused) throw new Error('일시 정지되어 게시하지 않았습니다.');
    } catch {
      this.store.finish(id, 'needs_attention', '게시 전 상품·원고 검증이 중단되었습니다. 다시 확인하세요.');
      return;
    }
    try {
      const result = await this.workflow.publish(this.publication(job));
      this.store.finish(id, 'published', result.previewStatus === 'visible' ? '공개 글과 링크 미리보기를 확인했습니다.' : '공개 글을 확인했습니다. 사이트에서 링크 미리보기가 표시되지 않았습니다.', result.url);
    } catch {
      this.store.finish(id, 'uncertain', 'Aside 작업이 계속 실행 중일 수 있습니다. 결과 확인 없이 다시 게시하지 마세요.');
    }
  }

  async execute(input: unknown): Promise<AppState> {
    const command = parseCommand(input);
    if (command.type === 'state') return this.store.state();
    if (command.type === 'pause') { this.store.setPaused(command.paused); return this.store.state(); }
    if (this.busy) throw new Error('진행 중인 작업이 있습니다. 완료 후 다시 시도하세요.');
    this.busy = true;
    try {
      const state = this.store.state();
      const browser = this.browserFor(state.settings.useWorkTabs);
      switch (command.type) {
        case 'openBrowser': await browser.open(command.channel); break;
        case 'scanProducts':
          for (const product of await browser.scanProducts()) {
            const existing = this.store.state().products.find(p => p.id === product.id);
            this.store.saveProduct(existing ? { ...product, shareUrl: existing.shareUrl, facts: existing.facts } : product);
          }
          break;
        case 'saveProduct': this.store.saveProduct(command.product); break;
        case 'issueLink': {
          const product = this.product(command.productId);
          if (product.soldOut) throw new Error('품절 상품은 발급하지 않습니다.');
          const shareUrl = await browser.issueLink(product);
          this.store.saveProduct({ ...product, shareUrl });
          break;
        }
        case 'generate': {
          const product = this.product(command.productId);
          if (product.soldOut || !product.shareUrl) throw new Error('판매 중 상품의 발급 링크가 필요합니다.');
          await browser.verifyProduct(product);
          const previous = state.drafts.map(d => d.title);
          const drafts = await this.workflow.generate(product, state.settings, previous);
          for (const draft of drafts) {
            const existing = state.drafts.find(d => d.productId === product.id && d.channel === draft.channel);
            this.store.saveDraft({ ...draft, id: existing?.id ?? randomUUID(), productId: product.id,
              version: existing?.version ?? 0, updatedAt: new Date().toISOString() });
          }
          break;
        }
        case 'saveDraft': this.store.saveDraft(command.draft); break;
        case 'approve': {
          const draft = state.drafts.find(d => d.id === command.draftId);
          if (!draft) throw new Error('원고를 찾을 수 없습니다.');
          this.workflow.assertPublishable({ requestId: randomUUID(), draft, product: this.product(draft.productId),
            target: draft.channel === 'naver' ? state.settings.naverBlogId : state.settings.threadsHandle,
            useWorkTabs: state.settings.useWorkTabs, onSession: () => { throw new Error('승인 단계에서는 작업을 실행하지 않습니다.'); } });
          this.store.approve(command.draftId, command.scheduledAt);
          break;
        }
        case 'runJob': await this.runJob(command.jobId); break;
        case 'checkJob': {
          const job = state.jobs.find(j => j.id === command.jobId);
          if (!job || job.status !== 'uncertain' || !job.asideSessionId) throw new Error('결과 확인할 Aside 작업이 없습니다.');
          const result = await this.workflow.recover(job.asideSessionId, this.publication(job));
          this.store.reconcile(job.id, result.url);
          break;
        }
        case 'cancelJob': this.store.cancel(command.jobId); break;
        case 'confirmNotPublished': this.store.confirmNotPublished(command.jobId); break;
        case 'reconcile': {
          const job = state.jobs.find(j => j.id === command.jobId);
          if (!job) throw new Error('작업을 찾을 수 없습니다.');
          this.store.reconcile(job.id, validateResultUrl(command.resultUrl, job.channel, job.target));
          break;
        }
        case 'saveSettings': this.store.saveSettings(command); break;
        case 'openResult': {
          const job = state.jobs.find(j => j.id === command.jobId);
          if (!job?.resultUrl) throw new Error('게시 주소가 없습니다.');
          await this.openExternal(validateResultUrl(job.resultUrl, job.channel, job.target));
          break;
        }
      }
      return this.store.state();
    } finally { this.busy = false; }
  }

  async tick(): Promise<void> {
    if (this.busy || this.store.state().paused) return;
    const now = Date.now();
    for (const job of this.store.state().jobs.filter(j => j.status === 'approved' && j.scheduledAt && Date.parse(j.scheduledAt) <= now)) {
      if (now - Date.parse(job.scheduledAt!) > 120000) {
        this.store.defer(job.id, '예약 시각이 지났습니다. 재승인이 필요합니다.');
        continue;
      }
      try { await this.execute({ type: 'runJob', jobId: job.id }); }
      catch {
        if (this.store.state().jobs.find(j => j.id === job.id)?.status === 'approved') this.store.defer(job.id, '예약 실행 전에 상품과 계정을 다시 확인하세요.');
      }
      break;
    }
  }
}
