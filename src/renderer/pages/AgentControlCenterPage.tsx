import { ArrowLeft, CheckCircle2, FileCheck2, LockKeyhole, RefreshCw, ShieldAlert, ShieldCheck, Trash2, UserRoundX } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { AgentControlApprovalSummary, AgentControlChangeSetSummary, AgentControlClientSummary, AgentControlR4GrantSummary, AgentControlSessionSummary, AgentControlStatus } from '../../shared/api';
import { trustProfiles, type AgentScope, type AuditKind, type OperationName, type TrustProfile } from '../../shared/agent/v1/gatewayContracts';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';

const scopeOptions: readonly AgentScope[] = ['questions.read', 'questions.write', 'questions.archive', 'reviews.read', 'reviews.submit', 'tasks.read', 'tasks.write', 'focus.read', 'focus.control', 'audit.read', 'operations.batch'];
const canonicalHash = /^sha256-v1:[0-9a-f]{64}$/;
const operationName = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const trustLabels: Readonly<Record<TrustProfile, string>> = { observer: '观察者', collaborator: '协作者', autonomous: '高自治', full_control: '完全控制' };

function isTrustProfile(value: string): value is TrustProfile {
  return trustProfiles.some((trust) => trust === value);
}

function formatDate(value?: string) { return value ? new Date(value).toLocaleString('zh-CN') : '-'; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function AgentControlCenterPage({ onBack }: { onBack: () => void }) {
  const modal = useModal();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<AgentControlStatus | null>(null);
  const [clients, setClients] = useState<readonly AgentControlClientSummary[]>([]);
  const [sessions, setSessions] = useState<readonly AgentControlSessionSummary[]>([]);
  const [grants, setGrants] = useState<readonly AgentControlR4GrantSummary[]>([]);
  const [approvals, setApprovals] = useState<readonly AgentControlApprovalSummary[]>([]);
  const [changeSets, setChangeSets] = useState<readonly AgentControlChangeSetSummary[]>([]);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof window.api.agentControl.searchAudit>>['items']>([]);
  const [policy, setPolicy] = useState<{ policyVersion: string; externalControlEnabled: boolean } | null>(null);
  const [catalog, setCatalog] = useState<{ version: string; hash: string } | null>(null);
  const [privacy, setPrivacy] = useState<{ revision: number; externalModelDataDisclosureRequired: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { scopes: AgentScope[]; trust: TrustProfile }>>({});
  const [auditClientId, setAuditClientId] = useState('');
  const [auditKind, setAuditKind] = useState<AuditKind | ''>('');
  const [verification, setVerification] = useState<{ label: string; valid: boolean; segments: number; events: number } | null>(null);
  const [r4FormError, setR4FormError] = useState('');
  const [r4Draft, setR4Draft] = useState({ clientId: '', operation: '', payloadHash: '', targetHash: '', maxAffectedEntities: '', expiresAt: '' });

  async function load() {
    setLoading(true); setError('');
    try {
      const [nextStatus, nextClients, nextSessions, nextGrants, nextApprovals, nextChanges, nextAudit, nextPolicy, nextCatalog, nextPrivacy] = await Promise.all([
        window.api.agentControl.getStatus(), window.api.agentControl.listClients({ pageSize: 100 }), window.api.agentControl.listSessions({ pageSize: 100 }), window.api.agentControl.listR4Grants({ pageSize: 100 }), window.api.agentControl.listApprovals({ pageSize: 100 }), window.api.agentControl.listChangeSets({ pageSize: 100 }), window.api.agentControl.searchAudit({ pageSize: 100 }), window.api.agentControl.getPolicy(), window.api.agentControl.getCatalog(), window.api.agentControl.getPrivacyDisclosure()
      ]);
      setStatus(nextStatus); setClients(nextClients.items); setSessions(nextSessions.items); setGrants(nextGrants.items); setApprovals(nextApprovals.items); setChangeSets(nextChanges.items); setAudit(nextAudit.items); setPolicy(nextPolicy); setCatalog(nextCatalog); setPrivacy(nextPrivacy);
      setDrafts(Object.fromEntries(nextClients.items.map((client) => [client.clientId, { scopes: [...client.scopes], trust: client.trust }])));
    } catch (nextError) { setError(errorMessage(nextError)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function act(key: string, action: () => Promise<unknown>, confirmation?: string) {
    if (confirmation && !await modal.confirm({ title: '确认外部智能体操作', message: confirmation, confirmLabel: '确认', danger: true })) return;
    setBusy(key); setError('');
    try { await action(); toast('操作已记录到本地审计', 'success'); await load(); } catch (nextError) { setError(errorMessage(nextError)); } finally { setBusy(null); }
  }
  async function searchAudit() {
    setBusy('audit-search'); setError('');
    try {
      const result = await window.api.agentControl.searchAudit({ ...(auditClientId.trim() ? { clientId: auditClientId.trim() } : {}), ...(auditKind ? { kinds: [auditKind] } : {}), pageSize: 100 });
      setAudit(result.items);
    } catch (nextError) { setError(errorMessage(nextError)); } finally { setBusy(null); }
  }
  async function verifyAudit(label: string, action: () => Promise<{ valid: boolean; segments: number; events: number }>) {
    setBusy(label); setError('');
    try {
      const result = await action();
      setVerification({ label, ...result });
      toast(result.valid ? '审计账本验证通过' : '审计账本验证失败', result.valid ? 'success' : 'error');
    } catch (nextError) { setError(errorMessage(nextError)); } finally { setBusy(null); }
  }
  async function createR4Grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setR4FormError(''); setError('');
    const client = clients.find((item) => item.clientId === r4Draft.clientId && !item.revokedAt);
    const maxAffectedEntities = Number(r4Draft.maxAffectedEntities);
    const expiresAtMs = Date.parse(r4Draft.expiresAt);
    if (!client) { setR4FormError('请选择一个未撤销的目标客户端。'); return; }
    if (!operationName.test(r4Draft.operation)) { setR4FormError('操作名称格式无效。'); return; }
    if (!canonicalHash.test(r4Draft.payloadHash) || !canonicalHash.test(r4Draft.targetHash)) { setR4FormError('载荷哈希和目标哈希必须使用 sha256-v1: 加 64 位小写十六进制。'); return; }
    if (!Number.isSafeInteger(maxAffectedEntities) || maxAffectedEntities < 1) { setR4FormError('最大影响数量必须是正整数。'); return; }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) { setR4FormError('到期时间必须晚于当前时间。'); return; }
    const expiresAt = new Date(expiresAtMs).toISOString();
    if (!await modal.confirm({
      title: '确认创建 R4 限时授权',
      message: `目标客户端：${client.displayName} (${client.clientId})\n绑定操作：${r4Draft.operation}\n到期时间：${formatDate(expiresAt)}\n\n授权只适用于当前载荷哈希、目标哈希和最大影响范围。`,
      confirmLabel: '创建授权',
      danger: true
    })) return;
    setBusy('r4-create');
    try {
      await window.api.agentControl.createR4Grant({
        clientId: client.clientId,
        operation: r4Draft.operation as OperationName,
        payloadHash: r4Draft.payloadHash,
        targetHash: r4Draft.targetHash,
        maxAffectedEntities,
        expiresAt
      });
      toast('R4 限时授权已创建并记录到本地审计', 'success');
      setR4Draft({ clientId: '', operation: '', payloadHash: '', targetHash: '', maxAffectedEntities: '', expiresAt: '' });
      await load();
    } catch (nextError) { setError(errorMessage(nextError)); } finally { setBusy(null); }
  }
  if (loading) return <div className="page agent-control-page"><div className="empty-state">正在加载外部智能体控制状态...</div></div>;

  return <div className="page agent-control-page">
    <header className="agent-control-hero">
      <div><button className="agent-back-button" type="button" onClick={onBack}><ArrowLeft size={16} />返回设置</button><span className="eyebrow">External Agent Control</span><h1>外部智能体控制中心</h1><p>本地管理授权、审批和可验证审计。外部控制默认关闭。</p></div>
      <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading || busy !== null}><RefreshCw size={16} />刷新</button>
    </header>
    {error ? <div className="warning-box"><strong>操作未完成</strong><p>{error}</p><button className="secondary-button compact-button" type="button" onClick={() => void load()}>重试加载</button></div> : null}
    <section className="agent-control-status">
      <div><span>外部控制</span><strong>{status?.settings.externalControlEnabled ? '已启用' : '已禁用'}</strong><small>运行状态：{status?.runtimeState ?? '-'}</small></div>
      <label className="agent-toggle"><input aria-label="外部控制开关" type="checkbox" checked={Boolean(status?.settings.externalControlEnabled)} onChange={(event) => void act('enabled', () => window.api.agentControl.setExternalControlEnabled(event.target.checked), event.target.checked ? '启用后，已授权外部客户端可按其 Scope 发起请求。' : '关闭将立即拒绝新的外部请求。')} disabled={busy === 'enabled'} /><span /></label>
    </section>
    <section className="agent-control-section"><h2><ShieldCheck size={18} /> 已授权客户端</h2>{clients.length ? clients.map((client) => {
      const draft = drafts[client.clientId] ?? { scopes: [...client.scopes], trust: client.trust };
      return <article className="agent-row" key={client.clientId}><div><strong>{client.displayName}</strong><small>{client.clientId} · 最近活动 {formatDate(client.lastActiveAt)}</small></div><label>信任<select value={draft.trust} onChange={(event) => { const trust = event.target.value; if (!isTrustProfile(trust)) return; setDrafts({ ...drafts, [client.clientId]: { ...draft, trust } }); }}>{trustProfiles.map((trust) => <option key={trust} value={trust}>{trustLabels[trust]}</option>)}</select></label><fieldset><legend>Scope</legend>{scopeOptions.map((scope) => <label key={scope}><input type="checkbox" checked={draft.scopes.includes(scope)} onChange={(event) => setDrafts({ ...drafts, [client.clientId]: { ...draft, scopes: event.target.checked ? [...draft.scopes, scope] : draft.scopes.filter((value) => value !== scope) } })} />{scope}</label>)}</fieldset><div className="agent-actions"><button className="secondary-button compact-button" type="button" disabled={busy === client.clientId} onClick={() => void act(client.clientId, () => window.api.agentControl.updateClientAccess(client.clientId, draft.scopes, draft.trust), `更新 ${client.displayName} 的 Scope 与信任级别。变更会立即终止其现有授权会话。`)}>保存访问</button><button className="icon-button danger" title="撤销客户端" type="button" disabled={busy === `revoke-${client.clientId}`} onClick={() => void act(`revoke-${client.clientId}`, () => window.api.agentControl.revokeClient(client.clientId), `撤销 ${client.displayName} 后，该客户端的新请求会立即失效。`)}><UserRoundX size={16} /></button></div></article>;
    }) : <div className="empty-state">尚无已授权客户端。</div>}</section>
    <section className="agent-control-section"><h2><LockKeyhole size={18} /> R4 限时授权</h2><form className="agent-r4-form" onSubmit={(event) => void createR4Grant(event)}><label>目标客户端<select required value={r4Draft.clientId} onChange={(event) => setR4Draft({ ...r4Draft, clientId: event.target.value })}><option value="">选择未撤销客户端</option>{clients.filter((client) => !client.revokedAt).map((client) => <option key={client.clientId} value={client.clientId}>{client.displayName} · {client.clientId}</option>)}</select></label><label>绑定操作<input required value={r4Draft.operation} onChange={(event) => setR4Draft({ ...r4Draft, operation: event.target.value.trim() })} placeholder="例如 questions.replace_all" /></label><label>载荷哈希<input required value={r4Draft.payloadHash} onChange={(event) => setR4Draft({ ...r4Draft, payloadHash: event.target.value.trim() })} placeholder="sha256-v1: 后接 64 位十六进制" /></label><label>目标哈希<input required value={r4Draft.targetHash} onChange={(event) => setR4Draft({ ...r4Draft, targetHash: event.target.value.trim() })} placeholder="sha256-v1: 后接 64 位十六进制" /></label><label>最大影响数量<input required min="1" step="1" type="number" value={r4Draft.maxAffectedEntities} onChange={(event) => setR4Draft({ ...r4Draft, maxAffectedEntities: event.target.value })} /></label><label>到期时间<input required type="datetime-local" value={r4Draft.expiresAt} onChange={(event) => setR4Draft({ ...r4Draft, expiresAt: event.target.value })} /></label><button className="primary-button" type="submit" disabled={busy === 'r4-create'}>{busy === 'r4-create' ? '正在创建...' : '创建操作绑定授权'}</button></form>{r4FormError ? <div className="agent-form-error" role="alert">{r4FormError}</div> : null}<p className="muted-text">控制中心只提交你确认的目标、操作、哈希、影响上限和到期时间；授权 ID、恢复要求和其他服务端字段由主进程生成与校验。</p>{grants.length ? grants.map((grant) => <article className="agent-row compact" key={grant.grantId}><div><strong>{grant.operation}</strong><small>客户端 {grant.clientId} · 最大影响 {grant.maxAffectedEntities} · {grant.recovery} · 到期 {formatDate(grant.expiresAt)}</small></div><span className="agent-badge">{grant.status}</span><button className="icon-button danger" title="撤销 R4 授权" type="button" onClick={() => void act(`grant-${grant.grantId}`, () => window.api.agentControl.revokeR4Grant(grant.grantId), `撤销绑定 ${grant.operation} 的 R4 授权。`)}><Trash2 size={16} /></button></article>) : <div className="empty-state">没有活动的 R4 限时授权。</div>}</section>
    <section className="agent-control-section"><h2><ShieldAlert size={18} /> 待审批操作</h2>{approvals.length ? approvals.map((approval) => <article className="agent-row compact" key={approval.approvalId}><div><strong>{approval.operation}</strong><small>{approval.clientId} · {approval.risk} · 到期 {formatDate(approval.expiresAt)}</small></div><span className="agent-badge">{approval.status}</span>{approval.status === 'pending' ? <div className="agent-actions"><button className="primary-button compact-button" type="button" onClick={() => void act(`approve-${approval.approvalId}`, () => window.api.agentControl.approve(approval.approvalId), `批准 ${approval.operation}，仅适用于当前绑定的目标和版本。`)}>批准</button><button className="secondary-button danger compact-button" type="button" onClick={() => void act(`reject-${approval.approvalId}`, () => window.api.agentControl.rejectApproval(approval.approvalId, 'user_rejected'), `拒绝 ${approval.operation}。`)}>拒绝</button></div> : null}</article>) : <div className="empty-state">当前没有待审批操作。</div>}</section>
    <section className="agent-control-section"><h2><FileCheck2 size={18} /> 变更集</h2>{changeSets.length ? changeSets.map((changeSet) => <article className="agent-row compact" key={changeSet.changeSetId}><div><strong>{changeSet.summary}</strong><small>{changeSet.clientId} · {changeSet.risk} · 到期 {formatDate(changeSet.expiresAt)}</small></div><span className="agent-badge">{changeSet.status}</span><div className="agent-actions">{changeSet.status === 'approved' ? <button className="primary-button compact-button" type="button" onClick={() => void act(`apply-${changeSet.changeSetId}`, () => window.api.agentControl.applyChangeSet(changeSet.changeSetId), `应用变更集：${changeSet.summary}。系统会重新验证版本与影响范围。`)}>应用</button> : null}{['draft', 'waiting_approval', 'approved'].includes(changeSet.status) ? <button className="secondary-button danger compact-button" type="button" onClick={() => void act(`change-reject-${changeSet.changeSetId}`, () => window.api.agentControl.rejectChangeSet(changeSet.changeSetId, 'user_rejected'), `拒绝变更集：${changeSet.summary}。`)}>拒绝</button> : null}</div></article>) : <div className="empty-state">没有待处理变更集。</div>}</section>
    <section className="agent-control-section"><h2>会话与即时终止</h2>{sessions.length ? sessions.map((session) => <article className="agent-row compact" key={session.sessionId}><div><strong>{session.clientId}</strong><small>会话到期 {formatDate(session.expiresAt)} · 最后活动 {formatDate(session.lastActiveAt)}</small></div><button className="secondary-button danger compact-button" type="button" onClick={() => void act(`session-${session.sessionId}`, () => window.api.agentControl.terminateSession(session.sessionId), `立即终止 ${session.clientId} 的当前会话。`)}>终止会话</button></article>) : <div className="empty-state">没有活跃外部会话。</div>}</section>
    <section className="agent-control-section"><h2>本地审计</h2><div className="agent-audit-filters"><label>客户端 ID<input value={auditClientId} onChange={(event) => setAuditClientId(event.target.value)} placeholder="留空查看全部客户端" /></label><label>事件类型<select value={auditKind} onChange={(event) => setAuditKind(event.target.value as AuditKind | '')}><option value="">全部类型</option><option value="control_changed">控制变更</option><option value="success">执行成功</option><option value="failure">执行失败</option><option value="denial">拒绝</option><option value="query">查询</option></select></label><button className="primary-button" type="button" disabled={busy === 'audit-search'} onClick={() => void searchAudit()}>检索审计</button></div><div className="agent-actions"><button className="secondary-button" type="button" disabled={busy === 'verify'} onClick={() => void verifyAudit('verify', () => window.api.agentControl.verifyAudit())}><CheckCircle2 size={16} />验证账本</button><button className="secondary-button" type="button" disabled={busy === 'export'} onClick={() => void verifyAudit('export', () => window.api.agentControl.exportAudit({ pageSize: 100 }))}>导出验证摘要</button></div>{verification ? <div className={verification.valid ? 'agent-verification valid' : 'agent-verification invalid'}>{verification.label === 'export' ? '导出摘要' : '账本验证'}：{verification.valid ? '完整' : '失败'} · {verification.segments} 个分段 · {verification.events} 条事件</div> : null}{audit.length ? <div className="agent-audit-list">{audit.map((event) => <div key={event.sequence}><strong>#{event.sequence} {event.kind}</strong><span>{event.operation ?? 'control'} · {event.clientId} · {formatDate(event.occurredAt)}</span></div>)}</div> : <div className="empty-state">当前筛选条件下没有审计记录。</div>}</section>
    <section className="agent-control-grid"><div className="agent-control-section"><h2>目录与策略</h2><p>策略版本：<strong>{policy?.policyVersion ?? '-'}</strong></p><p>目录版本：<strong>{catalog?.version ?? '-'}</strong></p><code>{catalog?.hash ?? '-'}</code></div><div className="agent-control-section privacy"><h2>隐私说明</h2><p>错题、复习记录、题目文本和图片默认只保存在本机。启用外部智能体后，只有被授权的外部模型在请求相应数据时才可能接收该范围内的学习数据。</p><p>请在授权 Scope 前确认模型供应商、其数据政策和当前请求范围。API Key、凭据和本地绝对路径不会通过控制中心或审计导出。</p><small>披露修订 {privacy?.revision ?? '-'} · {privacy?.externalModelDataDisclosureRequired ? '外部模型数据披露已要求' : '无外部模型披露要求'}</small></div></section>
  </div>;
}
