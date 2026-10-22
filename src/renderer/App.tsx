import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { DISCLOSURE } from '../shared';
import type { AppApi, AppState, Channel, Command, Draft, Job, JobStatus, Product } from '../shared';
import './styles.css';

declare global {
  interface Window {
    autoFlow: AppApi;
  }
}

type Panel = 'products' | 'drafts' | 'jobs' | 'settings';
type SettingsForm = AppState['settings'];
type Confirmation = {
  title: string;
  description: string;
  details: [string, string][];
  label: string;
  action: () => Promise<void>;
  publication?: boolean;
  jobId?: string;
};

const panelInfo: Record<Panel, { label: string; description: string }> = {
  products: { label: '상품', description: '판매 상태를 확인하고, 사실에 기반한 원고를 준비하세요.' },
  drafts: { label: '원고 검토', description: '문구, 광고 고지, 게시 계정을 확인한 뒤 승인하세요.' },
  jobs: { label: '게시 작업', description: '승인된 작업과 예약, 실제 게시 결과를 한곳에서 확인하세요.' },
  settings: { label: '설정', description: '공개 게시 계정과 글쓰기 지침, Aside 작업 방식을 관리하세요.' },
};
const channelName: Record<Channel, string> = { naver: '네이버 블로그', threads: 'Threads' };
const jobStatusName: Record<JobStatus, string> = {
  draft: '승인 대기', approved: '승인됨', running: '게시 중', published: '게시 완료',
  needs_attention: '확인 필요', uncertain: '결과 불확실', cancelled: '취소됨',
};
const commandName: Record<Command['type'], string> = {
  state: '상태 확인', openBrowser: 'Aside 탭 연결', scanProducts: 'Aside 상품 가져오기',
  saveProduct: '상품 저장', issueLink: '쉐어링크 발급', generate: '원고 생성',
  saveDraft: '원고 저장', approve: '게시 승인', runJob: '게시 실행', cancelJob: '작업 취소',
  checkJob: 'Aside 결과 확인', reconcile: '게시 결과 연결', confirmNotPublished: '미게시 확인', pause: '일시정지 변경', saveSettings: '설정 저장', openResult: '게시물 열기',
};

function dateText(value: string | null): string {
  if (!value) return '아직 확인하지 않음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '날짜 확인 필요' : date.toLocaleString('ko-KR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function sourceProductId(value: string): string | null {
  if (!safeUrl(value)) return null;
  return new URL(value).pathname.match(/\/links\/products\/(\d+)(?:\/|$)/)?.[1] ?? null;
}

function isFresh(product: Product | undefined): boolean {
  if (!product?.checkedAt) return false;
  const age = Date.now() - new Date(product.checkedAt).getTime();
  return age >= 0 && age <= 24 * 60 * 60 * 1000;
}

function Icon({ name }: { name: Panel | 'refresh' | 'arrow' | 'pause' }) {
  const paths: Record<typeof name, ReactNode> = {
    products: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="M3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5" /></>,
    drafts: <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></>,
    jobs: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18m-13 6 3 3 5-5" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    refresh: <><path d="M20 10a8 8 0 1 0-1 8M20 4v6h-6" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Badge({ children, kind = 'neutral' }: { children: ReactNode; kind?: string }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

function ProductCheck({ product }: { product: Product }) {
  if (product.soldOut) return <Badge kind="danger">품절</Badge>;
  if (!isFresh(product)) return <Badge kind="warning">재확인 필요</Badge>;
  return <Badge kind="success">판매 확인됨</Badge>;
}

function ProductScanStatus({ scan }: { scan: AppState['scan'] }) {
  if (!scan) return null;
  const title = scan.status === 'running' ? '상품 수집 중'
    : scan.status === 'failed' ? '상품 수집 중단'
      : scan.skipped.length ? '상품 수집 완료 · 일부 건너뜀' : '상품 수집 완료';
  return <section className="aside-task-info" role="status" aria-live="polite" aria-atomic="true" aria-label="상품 수집 상태">
    <strong>{title} · 확인·저장 {scan.saved}개</strong>
    {scan.skipped.length > 0 && <p>목록에서 찾지 못해 건너뛴 상품 {scan.skipped.length}개: {scan.skipped.map((product) => product.name).join(' · ')}</p>}
    {scan.status === 'failed' && <p>{scan.message}</p>}
  </section>;
}

function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">AF</span><h3>{title}</h3><p>{children}</p>{action && <div className="button-row">{action}</div>}</div>;
}

function AsideTaskInfo({ job }: { job: Job }) {
  return <div className="aside-task-info" role="status">
    <strong>Aside 작업 · {jobStatusName[job.status]}</strong>
    <p>세션: <span className="session-id">{job.asideSessionId || '기록 대기 중'}</span></p>
    {job.message && <p>{job.message.slice(0, 350)}</p>}
    <p>앱을 닫거나 응답이 끊겨도 원격 작업은 계속될 수 있습니다. 결과와 실제 게시물을 확인하기 전에는 다시 게시하지 마세요.</p>
  </div>;
}

function ConfirmDialog({ confirmation, pending, job, onClose, onError }: {
  confirmation: Confirmation; pending: boolean; job?: Job; onClose: () => void; onError: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-description" onCancel={(event) => {
    event.preventDefault();
    if (!pending) onClose();
  }}>
    <div className="dialog-heading"><span className="eyebrow">{confirmation.publication ? 'PUBLICATION CONFIRMATION' : 'CONFIRMATION'}</span><h2 id="confirm-title">{confirmation.title}</h2></div>
    <p id="confirm-description">{confirmation.description}</p>
    <dl className="confirm-details">{confirmation.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {pending && job && <AsideTaskInfo job={job} />}
    <div className="dialog-actions"><button type="button" className="button secondary" autoFocus disabled={pending} onClick={onClose}>돌아가기</button><button type="button" className="button primary" disabled={pending} onClick={() => {
      void confirmation.action().then(onClose).catch(onError);
    }}>{pending ? '처리 중…' : confirmation.label}</button></div>
  </dialog>;
}

export default function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [panel, setPanel] = useState<Panel>('products');
  const [pending, setPending] = useState<Command['type'] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const commandLock = useRef(false);
  const stateLock = useRef(false);
  const commandRevision = useRef(0);
  const mounted = useRef(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<Product | null>(null);
  const [productDirty, setProductDirty] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [draftForm, setDraftForm] = useState<Draft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [schedule, setSchedule] = useState('');
  const [jobFilter, setJobFilter] = useState('all');
  const [resultInputs, setResultInputs] = useState<Record<string, string>>({});
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const busy = pending !== null;
  const editingLocked = busy && pending !== 'state';

  const refreshState = useCallback(async (): Promise<AppState | null> => {
    if (stateLock.current) return null;
    stateLock.current = true;
    const revision = commandRevision.current;
    setPending((current) => current ?? 'state');
    try {
      if (!window.autoFlow || typeof window.autoFlow.execute !== 'function') {
        throw new Error('Auto Flow 데스크톱 앱에서 이 화면을 열어 주세요. 브라우저 대체 모드는 제공하지 않습니다.');
      }
      const next = await window.autoFlow.execute({ type: 'state' });
      if (mounted.current && revision === commandRevision.current) {
        setApp(next); setLastSynced(new Date().toISOString());
      }
      return next;
    } catch (cause) {
      if (mounted.current && revision === commandRevision.current) {
        const detail = cause instanceof Error ? cause.message.slice(0, 350) : '';
        setError((current) => current || `상태를 확인하지 못했습니다. 연결을 확인하고 새로고침하세요.${detail ? ` ${detail}` : ''}`);
      }
      return null;
    } finally {
      stateLock.current = false;
      if (mounted.current) setPending((current) => current === 'state' ? null : current);
    }
  }, []);

  const execute = useCallback(async (command: Command): Promise<AppState | null> => {
    if (command.type === 'state') return refreshState();
    if (commandLock.current) {
      setError('다른 작업을 처리 중입니다. 완료된 뒤 상태를 확인하세요. 게시 요청은 반복하지 마세요.');
      return null;
    }
    commandLock.current = true;
    commandRevision.current += 1;
    setPending(command.type);
    setError(''); setNotice('');
    try {
      if (!window.autoFlow || typeof window.autoFlow.execute !== 'function') {
        if (mounted.current) setError('데스크톱 연결을 찾을 수 없습니다. Auto Flow 데스크톱 앱에서 이 화면을 열어 주세요. 브라우저 대체 모드는 제공하지 않습니다.');
        return null;
      }
      const next = await window.autoFlow.execute(command);
      if (mounted.current) {
        setApp(next); setLastSynced(new Date().toISOString());
        if (command.type === 'openBrowser') setNotice(`Aside의 ${command.channel === 'toss' ? '토스' : '네이버'} 탭에 연결했습니다. 로그인과 대상 화면을 확인하세요.`);
      }
      return next;
    } catch (cause) {
      if (mounted.current) {
        const detail = cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 350)
          : '';
        const message = command.type === 'runJob' || command.type === 'approve' || command.type === 'checkJob'
          ? `${commandName[command.type]} 응답을 확인하지 못했습니다. 원격 Aside 작업은 계속될 수 있습니다. 게시를 반복하지 말고 상태와 Aside 결과, 실제 게시물을 먼저 확인하세요.`
          : command.type === 'scanProducts'
            ? '상품 가져오기를 완료하지 못했습니다. 중단 전에 확인·저장한 상품은 유지됩니다. 수집 결과와 연결 상태를 확인하세요.'
            : `${commandName[command.type]}을(를) 완료하지 못했습니다. 입력값과 연결 상태를 확인하세요. 저장된 원고와 작업 상태는 새로고침으로 확인할 수 있습니다.`;
        setError(`${message}${detail ? ` ${detail}` : ''}`);
      }
      if (command.type === 'scanProducts') {
        const revision = ++commandRevision.current;
        try {
          const next = await window.autoFlow.execute({ type: 'state' });
          if (mounted.current && revision === commandRevision.current) {
            setApp(next); setLastSynced(new Date().toISOString());
          }
        } catch {
          if (mounted.current) setError((current) => `${current} 저장된 상품과 수집 결과를 불러오지 못했습니다. 상태를 새로고침하세요.`);
        }
      }
      return null;
    } finally {
      commandRevision.current += 1;
      commandLock.current = false;
      if (mounted.current) setPending(null);
    }
  }, [refreshState]);

  useEffect(() => {
    mounted.current = true;
    void execute({ type: 'state' });
    const interval = window.setInterval(() => { void execute({ type: 'state' }); }, 5000);
    return () => { mounted.current = false; window.clearInterval(interval); };
  }, [execute]);

  useEffect(() => {
    if (!app || productDirty) return;
    const selected = app.products.find((product) => product.id === selectedProductId) ?? app.products[0] ?? null;
    setSelectedProductId(selected?.id ?? null);
    setProductForm(selected ? { ...selected } : null);
  }, [app, selectedProductId, productDirty]);

  useEffect(() => {
    if (!app || draftDirty) return;
    const selected = app.drafts.find((draft) => draft.id === selectedDraftId) ?? app.drafts[0] ?? null;
    setSelectedDraftId(selected?.id ?? null);
    setDraftForm(selected ? { ...selected } : null);
  }, [app, selectedDraftId, draftDirty]);

  useEffect(() => {
    if (!app || settingsDirty) return;
    const { naverBlogId, threadsHandle, tone, useWorkTabs } = app.settings;
    setSettingsForm({ naverBlogId, threadsHandle, tone, useWorkTabs });
  }, [app, settingsDirty]);

  useEffect(() => { setSchedule(''); }, [selectedDraftId]);

  const changeProduct = (changes: Partial<Product>) => {
    setProductForm((current) => {
      if (!current) return null;
      if (changes.sourceUrl === undefined) return { ...current, ...changes };
      const id = sourceProductId(changes.sourceUrl) ?? '';
      return { ...current, ...changes, id, ...(id !== current.id ? { checkedAt: '', shareUrl: '' } : {}) };
    });
    setProductDirty(true);
  };
  const changeDraft = (changes: Partial<Draft>) => {
    setDraftForm((current) => current ? { ...current, ...changes } : null);
    setDraftDirty(true);
  };
  const changeSettings = (changes: Partial<SettingsForm>) => {
    setSettingsForm((current) => current ? { ...current, ...changes } : null);
    setSettingsDirty(true);
  };
  const discardAllowed = (dirty: boolean) => !dirty || window.confirm('저장하지 않은 변경사항을 버리고 이동할까요?');
  const selectProduct = (product: Product) => {
    if (product.id === selectedProductId || !discardAllowed(productDirty)) return;
    setProductDirty(false); setSelectedProductId(product.id); setProductForm({ ...product });
  };
  const selectDraft = (draft: Draft) => {
    if (draft.id !== selectedDraftId && !discardAllowed(draftDirty)) return false;
    setSelectedDraftId(draft.id);
    if (draft.id !== selectedDraftId) { setDraftForm({ ...draft }); setDraftDirty(false); }
    return true;
  };
  const newProduct = () => {
    if (!discardAllowed(productDirty)) return;
    const product: Product = { id: '', name: '', sourceUrl: '', price: '', facts: '', shareUrl: '', soldOut: false, checkedAt: '' };
    setSelectedProductId(product.id); setProductForm(product); setProductDirty(true); setPanel('products');
  };
  const viewDraft = (draft: Draft) => { if (selectDraft(draft)) setPanel('drafts'); };

  const saveProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (!productForm) return;
    if (!safeUrl(productForm.sourceUrl) || (productForm.shareUrl && !safeUrl(productForm.shareUrl))) {
      setError('상품 URL과 쉐어링크는 유효한 http 또는 https 주소여야 합니다.'); return;
    }
    const sourceId = sourceProductId(productForm.sourceUrl);
    if (!sourceId) {
      setError('상품 원본 URL에 /links/products/숫자 형식의 실제 토스 상품 ID가 필요합니다. 상품 상세 주소를 확인하세요.'); return;
    }
    const next = await execute({ type: 'saveProduct', product: { ...productForm, id: sourceId } });
    if (next) {
      const saved = next.products.find((product) => product.id === productForm.id)
        ?? next.products.find((product) => product.sourceUrl === productForm.sourceUrl.trim());
      setSelectedProductId(saved?.id ?? null); setProductDirty(false); setNotice('상품을 저장했습니다. 게시 승인 전 실제 판매 상태를 확인하세요.');
    }
  };
  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draftForm) return;
    const next = await execute({ type: 'saveDraft', draft: draftForm });
    if (next) { setDraftDirty(false); setNotice('새 버전으로 저장했습니다. 기존 승인은 이어지지 않으므로 다시 검토하세요.'); }
  };
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!settingsForm) return;
    const next = await execute({ type: 'saveSettings', ...settingsForm });
    if (next) { setSettingsDirty(false); setNotice('설정을 저장했습니다. 공개 계정과 작업 탭 사용 여부를 확인하세요.'); }
  };
  const generate = async (product: Product) => {
    const next = await execute({ type: 'generate', productId: product.id });
    if (next) {
      setNotice('원고를 생성했습니다. 채널별 원고를 검토하고 광고 고지와 링크를 확인하세요.');
      const created = next.drafts.filter((draft) => draft.productId === product.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (created) viewDraft(created);
    }
  };
  const askIssueLink = (product: Product) => setConfirmation({
    title: '이 상품의 쉐어링크를 발급할까요?',
    description: 'Aside의 토스 화면에서 실제 쉐어링크 발급 동작을 요청합니다. 새 작업 탭 사용 설정에 따라 작업 탭 또는 기존 탭을 사용합니다. 연결된 계정과 상품을 먼저 확인하고, 자동화 중에는 작업 탭에서 이동하거나 편집하지 마세요. 직접 발급한 링크를 입력해도 됩니다.',
    details: [['상품', product.name], ['상품 주소', product.sourceUrl]], label: '쉐어링크 발급',
    action: async () => { if (await execute({ type: 'issueLink', productId: product.id })) setNotice('쉐어링크 발급 요청을 처리했습니다. 저장된 링크를 확인하세요.'); },
  });

  const productForDraft = app?.products.find((product) => product.id === draftForm?.productId);
  const draftTarget = draftForm ? (draftForm.channel === 'naver' ? app?.settings.naverBlogId : app?.settings.threadsHandle) ?? '' : '';
  const hasDisclosure = draftForm?.body.includes(DISCLOSURE) ?? false;
  const hasShareLink = Boolean(productForDraft?.shareUrl && draftForm?.body.includes(productForDraft.shareUrl));
  const existingApproval = Boolean(draftForm && app?.jobs.some((job) => job.draftId === draftForm.id
    && (['approved', 'running', 'uncertain'].includes(job.status) || (job.status === 'published' && job.version === draftForm.version))));
  const approvalBlocker = draftDirty ? '변경사항을 저장한 뒤 승인할 수 있습니다.'
    : !draftTarget ? '설정에서 게시 대상 계정을 먼저 입력하세요.'
      : !productForDraft || !isFresh(productForDraft) ? '상품 탭에서 24시간 이내의 실제 판매 상태를 확인하세요.'
        : productForDraft.soldOut ? '품절 상품은 승인할 수 없습니다.'
          : !hasDisclosure || !hasShareLink ? '원고에 광고 고지와 저장된 쉐어링크를 모두 포함하세요.'
            : existingApproval ? '이미 승인·진행 중이거나 게시된 버전입니다. 작업 상태를 확인하세요.'
              : app?.paused ? '일시정지를 해제한 뒤 승인하세요.' : '';

  const askApprove = () => {
    if (!draftForm || approvalBlocker) return;
    let scheduledAt: string | null = null;
    if (schedule) {
      const date = new Date(schedule);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        setError('예약 시각은 현재보다 이후의 유효한 현지 시간으로 입력하세요.'); return;
      }
      scheduledAt = date.toISOString();
    }
    const draft = draftForm;
    setConfirmation({
      title: scheduledAt ? '이 계정에 예약 게시를 승인할까요?' : '이 원고의 게시 준비를 승인할까요?',
      description: scheduledAt
        ? '이 승인은 아래 예약 시각에 실제 게시하는 것을 허용합니다. PC, Auto Flow 앱과 Aside가 실행 중이고 필요한 대상 탭에 접근할 수 있어야 합니다. 2분 넘게 놓친 예약은 자동 실행하지 않고 재검토·재승인이 필요합니다.'
        : '지금은 원고와 게시 대상을 승인합니다. 실제 게시는 작업 화면에서 별도로 확인한 후 실행됩니다.',
      details: [['채널', channelName[draft.channel]], ['게시 대상', draftTarget], ['원고', draft.title], ['검토 버전', `v${draft.version}`], ['게시 시각', scheduledAt ? `${dateText(scheduledAt)} · 이 PC의 현지 시간` : '예약 없음 · 작업 화면에서 직접 실행']],
      label: scheduledAt ? '예약 시각의 실제 게시 승인' : '게시 준비 승인', publication: Boolean(scheduledAt),
      action: async () => {
        const next = await execute({ type: 'approve', draftId: draft.id, scheduledAt });
        if (next) { setSchedule(''); setPanel('jobs'); setNotice(scheduledAt ? '예약 게시를 승인했습니다. 예약 시각 전에 PC, Auto Flow 앱과 Aside 실행 상태 및 대상 탭 접근 가능 여부를 확인하세요.' : '게시 준비를 승인했습니다. 실제 게시는 작업의 게시 버튼으로 실행하세요.'); }
      },
    });
  };

  const askRun = (job: Job) => {
    const draft = app?.drafts.find((item) => item.id === job.draftId);
    setConfirmation({
      title: '지금 실제로 게시할까요?',
      description: 'Aside가 연결된 계정에 아래 원고를 실제 게시합니다. 작업 중에는 대상 탭에서 직접 이동하거나 편집하지 마세요. 앱을 닫아도 원격 작업은 계속될 수 있습니다. 응답이 불확실하면 세션 결과와 실제 게시물을 먼저 확인하고, 중복 게시하지 마세요.',
      details: [['채널', channelName[job.channel]], ['게시 대상', job.target], ['원고', draft?.title ?? '저장된 승인 원고'], ['승인 버전', `v${job.version}`]],
      label: '지금 실제 게시', publication: true, jobId: job.id,
      action: async () => { if (await execute({ type: 'runJob', jobId: job.id })) setNotice('게시 실행 응답을 받았습니다. 작업 상태와 실제 게시물 주소를 확인하세요.'); },
    });
  };
  const askCancel = (job: Job) => setConfirmation({
    title: '이 게시 작업을 취소할까요?',
    description: '아직 실행되지 않은 이 작업을 취소합니다. 이미 게시된 글을 삭제하는 기능이 아닙니다.',
    details: [['채널', channelName[job.channel]], ['게시 대상', job.target], ['현재 상태', jobStatusName[job.status]]], label: '작업 취소',
    action: async () => { if (await execute({ type: 'cancelJob', jobId: job.id })) setNotice('작업을 취소했습니다.'); },
  });
  const askConfirmNotPublished = (job: Job) => setConfirmation({
    title: '실제 계정에서 미게시를 확인했나요?',
    description: 'Aside 원격 작업이 끝났는지 먼저 확인하세요. 대상 계정의 실제 게시물 목록을 직접 확인하고, 이 원고가 게시되지 않았음을 확실히 확인한 경우에만 진행하세요. 앱에 결과가 없거나 게시물을 찾지 못했다는 이유로 확인하면 중복 게시될 수 있습니다. 이 동작은 작업을 취소 상태로 바꿀 뿐 게시하지 않습니다. 다시 게시하려면 재검토·재승인이 필요합니다.',
    details: [['채널', channelName[job.channel]], ['직접 확인할 계정', job.target], ['승인 버전', `v${job.version}`]],
    label: '실제 계정의 미게시 확인 완료',
    action: async () => {
      if (await execute({ type: 'confirmNotPublished', jobId: job.id })) setNotice('미게시 확인을 처리했습니다. 다시 게시하려면 원고를 재검토하고 승인하세요. 이 동작으로 게시되지는 않습니다.');
    },
  });
  const askReconcile = (job: Job, event: FormEvent) => {
    event.preventDefault();
    const resultUrl = resultInputs[job.id]?.trim() ?? '';
    if (!safeUrl(resultUrl)) { setError('직접 확인한 실제 게시물의 유효한 http 또는 https 주소를 입력하세요.'); return; }
    setConfirmation({
      title: '실제 게시 결과를 이 작업에 연결할까요?',
      description: '이 주소가 표시된 계정에 실제로 게시된 해당 원고인지 직접 확인해야 합니다. 확인 전에는 다시 게시하지 마세요. 이 동작은 새 글을 게시하지 않습니다.',
      details: [['채널', channelName[job.channel]], ['게시 대상', job.target], ['실제 게시물', resultUrl]], label: '확인한 게시 결과 연결',
      action: async () => {
        if (await execute({ type: 'reconcile', jobId: job.id, resultUrl })) {
          setResultInputs((current) => ({ ...current, [job.id]: '' })); setNotice('게시 결과 확인 응답을 받았습니다. 작업 상태를 확인하세요.');
        }
      },
    });
  };

  const attentionCount = app?.jobs.filter((job) => job.status === 'needs_attention' || job.status === 'uncertain').length ?? 0;
  const approvedCount = app?.jobs.filter((job) => job.status === 'approved').length ?? 0;
  const recentEvents = [...(app?.events ?? [])].sort((left, right) => right.id - left.id).slice(0, 8);
  const filteredJobs = app?.jobs.filter((job) => jobFilter === 'all'
    || (jobFilter === 'attention' && ['uncertain', 'needs_attention'].includes(job.status))
    || (jobFilter === 'active' && ['approved', 'running', 'draft'].includes(job.status))
    || (jobFilter === 'done' && ['published', 'cancelled'].includes(job.status))) ?? [];

  return <div className="app-shell">
    <aside className="sidebar" aria-label="주 메뉴">
      <a href="#main-content" className="skip-link">본문 바로가기</a>
      <div className="brand"><span className="brand-mark">af<span>.</span></span><div><strong>Auto Flow</strong><span>PERSONAL PUBLISHING</span></div></div>
      <div className="workspace-label"><span className="status-dot" />개인 워크스페이스</div>
      <nav>{(Object.keys(panelInfo) as Panel[]).map((item) => <button key={item} type="button" className={`nav-item ${panel === item ? 'active' : ''}`} aria-current={panel === item ? 'page' : undefined} onClick={() => setPanel(item)}><Icon name={item} /><span>{panelInfo[item].label}</span>{app && item !== 'settings' && <span className="nav-count">{item === 'products' ? app.products.length : item === 'drafts' ? app.drafts.length : app.jobs.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-label"><span className="status-dot" />LOCAL DESKTOP</div><p>검토는 꼼꼼하게.<br />게시 결정은 명확하게.</p><span className="sidebar-note">텍스트 게시 워크플로</span></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">워크스페이스 <span>/</span> <strong>{panelInfo[panel].label}</strong></div><div className="topbar-actions"><span className="sync-status" role="status">{pending ? `${commandName[pending]} 중…` : lastSynced ? `${dateText(lastSynced)} 동기화` : '연결 대기'}</span><button type="button" className="icon-button" title="상태 새로고침" aria-label="상태 새로고침" disabled={busy} onClick={() => { void execute({ type: 'state' }); }}><Icon name="refresh" /></button>{app && <button type="button" className={`button compact ${app.paused ? 'paused-button' : 'secondary'}`} aria-pressed={app.paused} disabled={busy} onClick={() => {
        void execute({ type: 'pause', paused: !app.paused }).then((next) => { if (next) setNotice(next.paused ? '새 게시 시작을 일시정지했습니다. 이미 실행 중인 게시 작업은 계속될 수 있습니다.' : '일시정지를 해제했습니다. 승인된 예약은 예약 조건에 따라 실행됩니다.'); });
      }}><Icon name="pause" />{app.paused ? '일시정지 해제' : '일시정지'}</button>}</div></header>

      <main id="main-content" tabIndex={-1}>
        <div className="page-heading"><div><span className="eyebrow">YOUR PUBLISHING DESK</span><h1>{panelInfo[panel].label}</h1><p>{panelInfo[panel].description}</p></div>{app && panel === 'products' && <button type="button" className="button primary" disabled={busy} onClick={newProduct}>상품 직접 추가 <span aria-hidden="true">+</span></button>}</div>
        {error && <div className="alert alert-error" role="alert"><div><strong>작업을 확인해 주세요</strong><p>{error}</p></div><button type="button" className="text-button" onClick={() => setError('')} aria-label="오류 메시지 닫기">닫기</button></div>}
        {notice && <div className="alert alert-success" role="status"><p>{notice}</p><button type="button" className="text-button" onClick={() => setNotice('')} aria-label="안내 메시지 닫기">닫기</button></div>}
        {app?.paused && <div className="alert alert-warning"><p><strong>새 게시 시작이 일시정지되어 있습니다.</strong> 예약 게시도 새로 시작하지 않습니다. 이미 실행 중인 게시 작업은 완료될 수 있습니다.</p></div>}
        {panel !== 'jobs' && app?.jobs.some((job) => job.status === 'running' || job.status === 'uncertain') && <div className="alert alert-warning"><p>
          {app.jobs.some((job) => job.status === 'running') ? '앱에서 실행 중인 게시 작업이 있습니다. 앱을 닫아도 원격 작업은 계속될 수 있습니다. ' : '이전 게시 결과를 확인해야 하는 작업이 있습니다. 현재 실행 중이라는 뜻은 아닙니다. '}
          상품 수집 오류와는 별개이며 상품 가져오기를 차단하지 않습니다. 해당 글을 재게시하기 전에 게시 작업에서 결과를 확인하세요.
        </p><button type="button" className="text-button" onClick={() => setPanel('jobs')}>게시 작업 확인</button></div>}
        {app && panel === 'drafts' && <div className="info-note"><strong>이 화면은 원고 검토이며 실제 서비스 미리보기를 재현하지 않습니다.</strong> 광고 고지와 원본 링크를 확인하고, 대상 서비스가 제공하는 기본 링크 미리보기도 확인하세요. 미리보기와 이미지 표시 여부는 보장하지 않으며 직접 이미지 업로드는 지원하지 않습니다.</div>}
        {!app ? <section className="card"><EmptyState title={pending ? '로컬 워크스페이스에 연결 중입니다' : '워크스페이스를 불러오지 못했습니다'} action={<button type="button" className="button primary" disabled={busy} onClick={() => { void execute({ type: 'state' }); }}>다시 연결</button>}>실제 저장된 상품, 원고와 작업만 표시합니다. Auto Flow 데스크톱 앱 연결이 필요합니다.</EmptyState></section> : <>
          {panel === 'products' && <>
            <div className="workflow-strip"><div><span className="step-number">01</span><span><strong>상품 확인</strong><small>토스에서 상태 확인</small></span></div><span className="step-line" /><div><span className="step-number">02</span><span><strong>원고 검토</strong><small>고지·링크·사실 검토</small></span></div><span className="step-line" /><div><span className="step-number">03</span><span><strong>게시 승인</strong><small>대상과 시각 확인</small></span></div></div>
            <div className="action-bar"><div><strong>Aside 상품 가져오기</strong><p>Aside 로그인과 토스 상품 화면을 확인하세요. 절전·언로드된 탭은 직접 클릭해 화면을 표시해야 하며 자동으로 깨우지 않습니다. 작업 탭 사용 방식은 설정에서 정합니다.</p><button type="button" className="text-button" onClick={() => setPanel('settings')}>처음 사용: 설정과 사용 순서</button></div><div className="button-row"><button type="button" className="button secondary" disabled={busy} onClick={() => { void execute({ type: 'openBrowser', channel: 'toss' }); }}>토스 탭 연결</button><button type="button" className="button primary" disabled={busy} onClick={() => { void execute({ type: 'scanProducts' }); }}>Aside 상품 가져오기</button></div></div>
            <ProductScanStatus scan={app.scan} />
            <div className="info-note"><strong>목록에서 한 상품을 찾지 못해도 앞서 실제 확인·저장한 상품은 유지됩니다.</strong> 로그인 만료·보안 경고·상품 식별 모호성은 수집을 중단합니다. 각 상품의 확인 시각과 판매 상태를 검토하세요.</div>
            <div className="master-detail">
              <section className="card master-card" aria-label="상품 목록"><div className="card-heading"><h2>상품 목록 <span>{app.products.length}</span></h2></div><div className="search-field"><label className="sr-only" htmlFor="product-search">상품 검색</label><input id="product-search" type="search" placeholder="상품명으로 검색" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} /></div><div className="selection-list">{app.products.filter((product) => product.name.toLocaleLowerCase().includes(productSearch.toLocaleLowerCase())).map((product) => <button type="button" key={product.id} className={`selection-item ${selectedProductId === product.id ? 'selected' : ''}`} aria-pressed={selectedProductId === product.id} disabled={editingLocked} onClick={() => selectProduct(product)}><div className="list-item-top"><span className="product-monogram" aria-hidden="true">{product.name.slice(0, 1) || 'P'}</span><ProductCheck product={product} /></div><strong>{product.name}</strong><span className="list-secondary">{product.price || '가격 미입력'}</span><span className="list-meta">확인 {dateText(product.checkedAt)}</span></button>)}{!app.products.length && <div className="list-empty">등록된 상품이 없습니다.<br />상품을 확인하거나 직접 추가하세요.</div>}{app.products.length > 0 && !app.products.some((product) => product.name.toLocaleLowerCase().includes(productSearch.toLocaleLowerCase())) && <div className="list-empty">검색 결과가 없습니다.</div>}</div></section>
              <section className="card detail-card" aria-label="상품 편집">{productForm ? <>
                <div className="card-heading"><div><span className="eyebrow">PRODUCT DETAILS</span><h2>{app.products.some((product) => product.id === productForm.id) ? '상품 정보' : '새 상품 추가'}</h2></div><Badge kind={productDirty ? 'warning' : 'neutral'}>{productDirty ? '저장하지 않음' : '저장됨'}</Badge></div>
                <form onSubmit={(event) => { void saveProduct(event); }}><fieldset disabled={editingLocked}><div className="form-grid">
                  <label className="field full">상품명<input required value={productForm.name} onChange={(event) => changeProduct({ name: event.target.value })} placeholder="실제 상품명을 입력하세요" /></label>
                  <label className="field full">상품 원본 URL<input type="url" required value={productForm.sourceUrl} onChange={(event) => changeProduct({ sourceUrl: event.target.value })} placeholder="https://…/links/products/상품번호" spellCheck={false} /><small>URL의 /links/products/숫자에서 상품 ID를 읽습니다. {productForm.id ? `상품 ID: ${productForm.id}` : '실제 토스 상품 상세 주소를 입력하세요.'}</small></label>
                  <label className="field">표시 가격<input value={productForm.price} onChange={(event) => changeProduct({ price: event.target.value })} placeholder="상품 화면의 가격을 입력하세요" /></label>
                  <div className="field"><span>판매 상태</span><label className="checkbox-field"><input type="checkbox" checked={productForm.soldOut} onChange={(event) => changeProduct({ soldOut: event.target.checked })} />품절 상품입니다</label></div>
                  <label className="field full">추가 상품 메모 <span className="optional">선택</span><textarea rows={5} value={productForm.facts} onChange={(event) => changeProduct({ facts: event.target.value })} placeholder="추가로 확인한 사양, 구성, 주의사항이 있을 때만 입력하세요. 확인하지 않은 효과나 사용 경험은 넣지 마세요." /><small>비워 두어도 확인된 상품명·가격과 쉐어링크로 원고를 생성합니다. 수집된 정보를 다시 입력할 필요는 없습니다. 가격·혜택은 게시 전에 다시 확인하세요.</small></label>
                  <label className="field full">토스 쉐어링크<input type="url" value={productForm.shareUrl} onChange={(event) => changeProduct({ shareUrl: event.target.value })} placeholder="직접 발급받은 실제 쉐어링크도 입력할 수 있습니다" spellCheck={false} /></label>
                </div><div className="form-footer"><span className="muted">실제 판매 확인: {dateText(productForm.checkedAt)}</span><button className="button primary" type="submit" disabled={busy || !productDirty}>상품 저장</button></div></fieldset></form>
                <div className="detail-actions"><div className="button-row"><button type="button" className="button secondary" disabled={busy || productDirty} onClick={() => askIssueLink(productForm)}>쉐어링크 발급</button><button type="button" className="button primary" disabled={busy || productDirty || !productForm.shareUrl || productForm.soldOut} onClick={() => { void generate(productForm); }}>채널별 원고 생성 <Icon name="arrow" /></button></div><p>{productDirty ? '변경사항을 저장해야 링크 발급과 원고 생성을 진행할 수 있습니다.' : 'Aside가 확인된 상품명·가격과 쉐어링크로 원고를 생성합니다. 추가 메모는 선택이며, 생성은 게시가 아닙니다.'}</p><p>직접 추가한 상품도 게시 승인 전에는 실제 토스 상품 화면에서 판매 상태를 확인해야 합니다.</p></div>
              </> : <EmptyState title="첫 상품부터 시작하세요" action={<button type="button" className="button primary" disabled={busy} onClick={newProduct}>상품 직접 추가</button>}>Aside의 토스 탭에서 상품을 확인하거나, 실제 상품 정보와 발급받은 쉐어링크를 직접 입력하세요.</EmptyState>}</section>
            </div><div className="info-note"><strong>본문과 링크를 게시하며, 서비스가 제공하는 기본 링크 미리보기는 유지합니다.</strong> 미리보기와 이미지 표시 여부는 서비스·링크에 따라 달라지며 보장하지 않습니다. 직접 이미지 업로드는 지원하지 않습니다. 향후 사용 권한을 검증하는 절차 없이는 이미지 수집·첨부를 하지 않습니다. 자동화 중에는 작업 탭을 편집하지 마세요. 접근 제한을 우회하거나 자동 재시도하지 않습니다.</div>
          </>}

          {panel === 'drafts' && <div className="master-detail draft-layout"><section className="card master-card" aria-label="원고 목록"><div className="card-heading"><h2>작성된 원고 <span>{app.drafts.length}</span></h2></div><div className="selection-list">{app.drafts.map((draft) => <button type="button" key={draft.id} className={`selection-item ${selectedDraftId === draft.id ? 'selected' : ''}`} aria-pressed={selectedDraftId === draft.id} disabled={editingLocked} onClick={() => { selectDraft(draft); }}><div className="list-item-top"><Badge kind={draft.channel}>{channelName[draft.channel]}</Badge><span className="version-label">v{draft.version}</span></div><strong>{draft.title || '제목 없음'}</strong><span className="list-secondary">{app.products.find((product) => product.id === draft.productId)?.name ?? '연결 상품 확인 필요'}</span><span className="list-meta">수정 {dateText(draft.updatedAt)}</span></button>)}{!app.drafts.length && <div className="list-empty">생성된 원고가 없습니다.</div>}</div></section><section className="card detail-card" aria-label="원고 편집">{draftForm ? <><div className="card-heading"><div><span className="eyebrow">DRAFT EDITOR</span><h2>{channelName[draftForm.channel]} 원고</h2></div><Badge kind={draftDirty ? 'warning' : 'neutral'}>{draftDirty ? `수정 중 · 저장 시 v${draftForm.version + 1}` : `저장된 버전 v${draftForm.version}`}</Badge></div><form onSubmit={(event) => { void saveDraft(event); }}><fieldset disabled={editingLocked}><div className="form-grid"><label className="field full">제목<input required value={draftForm.title} onChange={(event) => changeDraft({ title: event.target.value })} /></label><label className="field full">본문<textarea className="draft-body" required rows={15} value={draftForm.body} onChange={(event) => changeDraft({ body: event.target.value })} /><small>{draftForm.body.length.toLocaleString('ko-KR')}자 · 텍스트 전용 · 수정된 원고는 새 버전으로 저장하고 다시 승인해야 합니다.</small></label></div><div className="form-footer"><span className="muted">최근 저장 {dateText(draftForm.updatedAt)}</span><button type="submit" className="button primary" disabled={busy || !draftDirty}>새 버전으로 저장</button></div></fieldset></form><div className="review-section"><div className="section-title"><h3>게시 전 검토</h3><span>버전 v{draftForm.version}</span></div><dl className="review-details"><div><dt>게시 대상</dt><dd><strong>{channelName[draftForm.channel]}</strong> · {draftTarget || '설정되지 않음'}</dd></div><div><dt>연결 상품</dt><dd>{productForDraft?.name ?? '상품을 찾을 수 없음'} {productForDraft && <ProductCheck product={productForDraft} />}</dd></div></dl><div className="disclosure-box"><div className="section-title"><strong>필수 광고 고지</strong><Badge kind={hasDisclosure ? 'success' : 'warning'}>{hasDisclosure ? '본문 포함' : '본문에 추가 필요'}</Badge></div><p>{DISCLOSURE}</p><div className="review-link"><span>검토할 쉐어링크</span>{productForDraft?.shareUrl && safeUrl(productForDraft.shareUrl) ? <a href={safeUrl(productForDraft.shareUrl) ?? undefined} target="_blank" rel="noopener noreferrer">{productForDraft.shareUrl}</a> : <strong>등록된 유효한 링크 없음</strong>}<Badge kind={hasShareLink ? 'success' : 'warning'}>{hasShareLink ? '본문 포함' : '본문 확인 필요'}</Badge></div></div><label className="field schedule-field" htmlFor="schedule">예약 시각 <span className="optional">선택 · 이 PC의 현지 시간</span><input id="schedule" type="datetime-local" value={schedule} disabled={editingLocked} onChange={(event) => setSchedule(event.target.value)} /><small>비워 두면 승인 후 작업 화면에서 직접 게시합니다. 예약하면 승인한 시각에 자동 게시됩니다.</small></label><div className="approval-footer"><p>{approvalBlocker || '사실, 광고 고지, 링크와 게시 대상을 직접 확인한 뒤 승인하세요.'}</p><button type="button" className="button primary" disabled={busy || Boolean(approvalBlocker)} onClick={askApprove}>{schedule ? '예약 게시 승인' : '게시 준비 승인'}</button></div><p className="schedule-note">예약 실행에는 켜진 PC와 실행 중인 앱이 필요합니다. 2분 넘게 놓친 예약은 수동 확인 후 재승인하세요. 일시정지는 새 실행만 막으며 진행 중인 게시를 되돌리지 않습니다.</p></div></> : <EmptyState title="검토할 원고를 만들어 보세요" action={<button type="button" className="button primary" onClick={() => setPanel('products')}>상품에서 원고 생성</button>}>확인된 상품명·가격과 쉐어링크로 채널별 원고를 생성하세요. 추가 메모는 선택이며 원고 생성만으로 게시되지는 않습니다.</EmptyState>}</section></div>}

          {panel === 'jobs' && <>
            <div className="metrics-grid"><div className="metric card"><span>승인된 작업</span><strong>{approvedCount}<small>건</small></strong><p>계정과 예약 시각을 확인하세요</p></div><div className="metric card"><span>직접 확인 필요</span><strong className={attentionCount ? 'warning-text' : ''}>{attentionCount}<small>건</small></strong><p>불확실한 결과는 재게시하지 마세요</p></div><div className="metric card"><span>게시 완료</span><strong>{app.jobs.filter((job) => job.status === 'published').length}<small>건</small></strong><p>실제 게시물에서 최종 확인</p></div></div>
            <div className="info-note"><strong>예약은 사전 승인한 게시에만 적용됩니다.</strong> PC, Auto Flow 앱과 Aside가 실행 중이고 필요한 대상 탭에 접근할 수 있어야 합니다. 2분 넘게 놓친 예약은 자동 게시하지 않으며, 원고를 다시 확인하고 재승인해야 합니다. 예약 없는 작업은 아래에서 직접 게시하세요.</div>
            <section className="jobs-section"><div className="section-toolbar"><h2>게시 작업 <span className="count-text">{app.jobs.length}</span></h2><div className="segmented-control" aria-label="작업 필터">{[['all', '전체'], ['active', '진행 대기'], ['attention', '확인 필요'], ['done', '완료·취소']].map(([value, label]) => <button type="button" key={value} className={jobFilter === value ? 'selected' : ''} aria-pressed={jobFilter === value} onClick={() => setJobFilter(value)}>{label}</button>)}</div></div><div className="job-list">{filteredJobs.map((job) => {
              const draft = app.drafts.find((item) => item.id === job.draftId);
              const scheduledTime = job.scheduledAt ? new Date(job.scheduledAt).getTime() : null;
              const future = scheduledTime !== null && scheduledTime > Date.now();
              const overdue = scheduledTime !== null && Date.now() - scheduledTime > 120000;
              return <article key={job.id} className={`card job-card ${job.status === 'uncertain' ? 'job-uncertain' : ''}`}>
                <div className="job-heading"><div className="job-title"><div className="button-row"><Badge kind={job.status}>{jobStatusName[job.status]}</Badge><span className="channel-text">{channelName[job.channel]}</span><span className="version-label">v{job.version}</span></div><h3>{draft?.title ?? '저장된 게시 작업'}</h3></div><span className="job-time">{dateText(job.updatedAt)}</span></div>
                <dl className="job-details"><div><dt>게시 대상</dt><dd>{job.target || '대상 확인 필요'}</dd></div><div><dt>예약</dt><dd>{job.scheduledAt ? `${dateText(job.scheduledAt)} · 현지 시간` : '직접 게시'}{job.status === 'approved' && overdue && <span className="warning-text"> · 시각 경과, 재검토 필요</span>}</dd></div></dl>
                {job.status === 'running' || job.status === 'uncertain' ? <>
                  <AsideTaskInfo job={job} />
                  {job.status === 'uncertain' && job.asideSessionId && <div className="aside-recovery"><button type="button" className="button secondary" disabled={busy} onClick={() => {
                    void execute({ type: 'checkJob', jobId: job.id }).then((next) => { if (next) setNotice('기존 Aside 세션의 결과를 조회했습니다. 작업 상태와 실제 게시물 URL을 확인하세요. 새 게시 요청은 하지 않았습니다.'); });
                  }}>{pending === 'checkJob' ? 'Aside 결과 확인 중…' : 'Aside 결과 확인'}</button><p>저장된 세션을 읽기 전용으로 조회합니다. 게시 재실행이나 아래 수동 결과 연결과는 별개입니다.</p></div>}
                </> : job.message && <p className="job-message">{job.message.slice(0, 600)}</p>}
                {job.status === 'uncertain' && <div className="reconcile-form"><strong>원본 계정에서 실제 게시 여부를 먼저 확인하세요.</strong><p>이미 게시되었다면 해당 글의 정확한 주소를 입력하세요. 게시되지 않았음을 확실히 확인했다면 아래 미게시 확인을 진행하세요. 단순히 게시물을 찾지 못한 경우에는 재게시하지 마세요.</p><form onSubmit={(event) => askReconcile(job, event)}><label className="field" htmlFor={`result-${job.id}`}>직접 확인한 실제 게시물 URL<input id={`result-${job.id}`} type="url" required placeholder="https://…" disabled={editingLocked} value={resultInputs[job.id] ?? ''} onChange={(event) => setResultInputs((current) => ({ ...current, [job.id]: event.target.value }))} /></label><div className="button-row"><button type="submit" className="button secondary" disabled={busy || !resultInputs[job.id]?.trim()}>게시 결과 연결</button><button type="button" className="text-button" disabled={busy} onClick={() => askConfirmNotPublished(job)}>미게시 확인</button></div></form><p>미게시 확인은 작업 취소만 처리합니다. 다시 게시하려면 원고를 검토하고 재승인해야 합니다.</p></div>}
                <div className="job-actions"><div className="button-row">{draft && <button type="button" className="button secondary compact" disabled={editingLocked} onClick={() => viewDraft(draft)}>원고 검토</button>}{['approved', 'draft', 'needs_attention'].includes(job.status) && <button type="button" className="text-button danger-text" disabled={busy} onClick={() => askCancel(job)}>작업 취소</button>}</div><div className="button-row">{job.resultUrl && <button type="button" className="button secondary compact" disabled={busy} onClick={() => { void execute({ type: 'openResult', jobId: job.id }); }}>실제 게시물 열기</button>}{job.status === 'approved' && <button type="button" className="button primary compact" disabled={busy || app.paused || future || overdue} onClick={() => askRun(job)}>{future ? '예약 시각에 자동 게시' : overdue ? '예약 재검토 필요' : '지금 게시 확인'}</button>}</div></div>
                {job.resultUrl && <p className="result-url" title={job.resultUrl}>{job.resultUrl}</p>}
              </article>;
            })}{!filteredJobs.length && <section className="card"><EmptyState title={app.jobs.length ? '해당하는 작업이 없습니다' : '아직 승인한 작업이 없습니다'} action={!app.jobs.length ? <button type="button" className="button primary" onClick={() => setPanel('drafts')}>원고 검토하기</button> : undefined}>{app.jobs.length ? '다른 필터를 선택해 작업 상태를 확인하세요.' : '검토한 원고를 승인하면 여기에 게시 대상, 버전과 예약 시각이 표시됩니다.'}</EmptyState></section>}</div></section>
            <section className="card events-card"><div className="card-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>최근 앱 활동</h2></div><span className="muted">최근 8건만 표시</span></div>{recentEvents.length ? <ol className="event-list">{recentEvents.map((event) => <li key={event.id}><span className="event-dot" /><p>{event.message.slice(0, 280)}</p><time dateTime={event.at}>{dateText(event.at)}</time></li>)}</ol> : <p className="list-empty">아직 기록된 앱 활동이 없습니다.</p>}</section>
          </>}

          {panel === 'settings' && settingsForm && <>
            <section className="card setup-guide" aria-labelledby="setup-title"><div className="card-heading"><div><span className="eyebrow">START HERE</span><h2 id="setup-title">설정과 사용 순서</h2></div></div><ol className="setup-checklist">
              <li>Aside 앱과 CLI를 준비하고 실행한 뒤, 토스·네이버·Threads에 로그인합니다.</li>
              <li>아래 공개 블로그 ID와 Threads @handle, 작업 탭 사용 여부를 저장합니다.</li>
              <li>상품명·가격·판매 상태와 해당 쉐어링크를 확인합니다. 추가 메모는 선택이며, 수집된 정보를 다시 입력할 필요는 없습니다.</li>
              <li>채널별 원고 생성을 눌러 Aside가 작성한 두 채널의 원고를 받습니다.</li>
              <li>사실관계·광고 고지·링크를 검토하고 서비스가 제공하는 미리보기도 확인합니다.</li>
              <li>게시 계정·원고 버전·예약 여부를 확인하고 게시 준비를 승인합니다.</li>
              <li>게시 작업에서 실제 게시를 확인합니다. 예약은 승인한 시각에 실행됩니다.</li>
              <li>작업 결과의 실제 공개 URL을 열어 계정·본문·링크를 최종 확인합니다.</li>
            </ol></section>
            <div className="settings-layout">
            <form className="settings-form" onSubmit={(event) => { void saveSettings(event); }}><fieldset disabled={editingLocked}>
              <section className="card"><div className="card-heading"><div><span className="eyebrow">PUBLISHING ACCOUNTS</span><h2>게시 계정</h2></div>{settingsDirty && <Badge kind="warning">저장하지 않음</Badge>}</div><div className="form-grid">
                <label className="field full">네이버 블로그 ID<input value={settingsForm.naverBlogId} onChange={(event) => changeSettings({ naverBlogId: event.target.value })} placeholder="예: my_blog" autoComplete="off" spellCheck={false} /><small>blog.naver.com/ 뒤의 공개 블로그 ID만 입력하세요. 주소 전체는 입력하지 않습니다.</small></label>
                <label className="field full">Threads @handle<input value={settingsForm.threadsHandle} onChange={(event) => changeSettings({ threadsHandle: event.target.value })} placeholder="예: @my_handle" autoComplete="off" spellCheck={false} /><small>threads.com/@ 뒤의 공개 사용자명을 입력하세요. Aside에 로그인된 실제 게시 계정과 같아야 합니다.</small></label>
              </div></section>
              <section className="card"><div className="card-heading"><div><span className="eyebrow">WRITING PREFERENCES</span><h2>원고 생성 설정</h2></div></div><div className="form-grid">
                <label className="field full">문체와 작성 지침<textarea required rows={4} value={settingsForm.tone} onChange={(event) => changeSettings({ tone: event.target.value })} placeholder="예: 친근한 해요체로 짧게 소개해요. 구성과 가격은 쉽게, 단가 계산은 필요할 때 한 번만." /><small>블로그는 짧은 문단으로, Threads는 핵심부터 간결하게 작성합니다. 확인되지 않은 사용 후기·효능·최저가, 거짓 마감·품절 임박 문구는 넣지 않습니다. 변경은 이후 생성 원고에 적용되며 기존 원고나 게시물을 자동 수정하지 않습니다.</small></label>
                <div className="copy-examples full"><h3>설명문보다 자연스러운 상품 소개</h3><ul><li><strong>구성·가격:</strong> “제공된 가격은”보다 “4개 묶음이고, 지금 확인한 가격은 …원이에요”처럼 쉽게 설명해요.</li><li><strong>단가:</strong> 도움이 될 때 “한 개에 …원꼴이에요” 정도만 덧붙여요. 여러 단위를 계산해서 나열하지 않아요.</li><li><strong>도입과 마무리:</strong> 상품에 맞는 생활 상황을 짧게 건네고, 링크 확인을 가볍게 안내해요. 직접 써 본 경험은 만들지 않아요.</li></ul></div>
              </div></section>
              <section className="card"><div className="card-heading"><div><span className="eyebrow">ASIDE WORK TABS</span><h2>작업 탭</h2></div></div><div className="form-grid"><div className="field full"><label className="checkbox-field" htmlFor="use-work-tabs"><input id="use-work-tabs" type="checkbox" checked={settingsForm.useWorkTabs} onChange={(event) => changeSettings({ useWorkTabs: event.target.checked })} aria-describedby="work-tabs-description" />새 작업 탭 사용</label><p id="work-tabs-description">이 설정을 켜고 저장한 경우에만 Aside의 기존 로그인을 사용하는 새 작업 탭을 만듭니다. 절전·언로드된 사용자 탭을 강제로 깨우거나 권한을 바꾸지 않고 작업할 수 있습니다.</p><small>끄면 기존 탭을 사용합니다. 필요한 탭을 직접 열어 화면이 표시되게 하세요. 여러 대상 탭이 있으면 Aside에서 사용할 탭을 직접 선택해야 합니다. 쿠키·프로필은 복사하지 않으며 접근 제한은 우회하지 않습니다.</small></div></div></section>
              <div className="settings-save"><span className="muted">설정을 바꾼 뒤에는 기존 작업의 게시 대상도 확인하세요.</span><button type="submit" className="button primary" disabled={busy || !settingsDirty}>설정 저장</button></div>
            </fieldset></form>
            <aside className="settings-aside"><section className="card"><span className="eyebrow">ASIDE CONNECTION</span><h2>Aside 연결</h2><p>원고 생성과 네이버·Threads 게시 모두 Aside가 처리합니다. 이 PC에서 Aside 앱과 CLI를 실행할 수 있어야 하며, 게시는 Aside의 기존 서비스 로그인을 사용합니다.</p><div className="stacked-buttons"><button type="button" className="button secondary" disabled={busy || settingsDirty} onClick={() => { void execute({ type: 'openBrowser', channel: 'toss' }); }}>토스 탭 연결</button><button type="button" className="button secondary" disabled={busy || settingsDirty} onClick={() => { void execute({ type: 'openBrowser', channel: 'naver' }); }}>네이버 탭 연결</button></div><p className="small-text">설정을 먼저 저장하세요. 탭 연결은 게시 승인이나 실제 게시가 아닙니다. 로그인 만료·권한 요청·보안 경고가 나타나면 Aside에서 직접 확인하세요. 자동화 중에는 작업 탭에서 이동하거나 편집하지 마세요.</p></section><section className="card policy-card"><h2>미리보기와 이미지</h2><ul><li>본문의 링크에 서비스가 제공하는 기본 미리보기가 있으면 유지합니다. 이 앱은 실제 서비스 미리보기를 재현하지 않습니다.</li><li>미리보기·이미지 표시는 서비스와 링크에 따라 달라지며 항상 표시된다고 보장하지 않습니다.</li><li>직접 이미지 업로드는 지원하지 않습니다. 향후 사용 권한을 검증하는 절차 없이 이미지를 수집·첨부하지 않습니다.</li></ul></section><section className="card policy-card"><h2>안전한 게시</h2><ul><li>원고 사실관계·광고 고지·링크·게시 계정을 검토하고 승인하세요.</li><li>예약 시각에는 PC, Auto Flow 앱과 Aside가 실행 중이어야 합니다. 2분 넘게 놓친 예약은 다시 검토하고 승인하세요.</li><li>앱 종료·응답 시간 초과 뒤에도 원격 Aside 작업은 계속될 수 있습니다. 결과가 불확실하면 게시 작업의 세션 결과와 실제 계정을 확인하고, 무작정 다시 실행하지 마세요.</li><li>브라우저 화면·서비스 정책 변경이나 접근 제한으로 중단되면 원본 화면을 확인하세요. 권한 우회·자동 재시도는 하지 않습니다.</li></ul></section></aside>
          </div></>}
        </>}
        <footer className="page-footer"><span>Auto Flow <span className="footer-divider">/</span> 개인용 게시 도구</span><p>게시 결정은 직접 승인하세요. 불확실한 결과는 Aside 세션과 실제 게시물에서 확인하고 중복 게시하지 마세요.</p></footer>
      </main>
    </div>
    {confirmation && <ConfirmDialog confirmation={confirmation} pending={busy} job={app?.jobs.find((job) => job.id === confirmation.jobId)} onClose={() => setConfirmation(null)} onError={() => { setConfirmation(null); setError('확인 동작을 완료하지 못했습니다. 작업 상태를 먼저 확인하세요.'); }} />}
  </div>;
}
