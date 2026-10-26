import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OssRuntime } from '../src/oss/runtime.js'
import { ResearchPlans } from '../src/oss/research-plans.js'
import type { ResearchDefinition, ResearchPlan, PlanDecision } from '../src/oss/research-plan-types.js'
import type { Execution } from '../src/oss/types.js'
let directory: string; let runtime: OssRuntime; const stores: ResearchPlans[] = []
const definition = (title = 'Inspect inputs'): ResearchDefinition => ({ title, objective: 'Preserve source and inspect object state', steps: ['inspect','report'].map(id => ({ id, title: id, inputs: ['declared:path'], outputs: ['declared:report'], methods: ['method v1, declared'], risk: 'No implicit transforms', acceptance: 'Check actual receipt and inspect findings' })) })
const decide = (plan: ResearchPlan, action: PlanDecision['action'], operationId: string, extra: Partial<PlanDecision> = {}): PlanDecision => ({ id: plan.id, revision: plan.revision, operationId, action, note: 'Human reviewed this exact version', ...extra })
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oss-research-plan-')); runtime = await OssRuntime.open({ stateDir: join(directory, 'state'), python: '/not-needed-for-plan-metadata' }); await runtime.project(directory) })
afterEach(async () => { for (const store of stores.splice(0)) await store.dispose(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
describe('durable human-governed scientific plans', () => {
  it('records immutable revisions, resets approval on edit and deduplicates retries without restoring old approval', async () => {
    const plans = await runtime.researchPlans(directory); const proposal = { definition: definition(), operationId: 'proposal' }; const draft = await plans.propose(proposal, 'agent:session-a')
    expect(draft.status).toBe('draft'); expect(draft.actor).toBe('agent:session-a')
    expect((await plans.propose(proposal, 'agent:session-a')).id).toBe(draft.id)
    const decision = decide(draft, 'approve','approve'); const approved = await plans.decide(decision)
    expect(approved.approval?.definitionSha256).toBe(approved.definitionSha256)
    await expect(plans.decide(decide(draft,'reject','stale'))).rejects.toMatchObject({ status: 409 })
    const edit = await plans.propose({ id: draft.id, revision: approved.revision, definition: definition('Revised methods'), operationId: 'edit' }, 'agent:session-a')
    expect(edit.status).toBe('draft'); expect(edit.approval).toBeUndefined(); expect(edit.assessments).toEqual([])
    expect((await plans.decide(decision)).status).toBe('draft'); expect(plans.history(draft.id).revisions.map(node => node.revision)).toEqual([3,2,1])
    expect(plans.get(draft.id,2).approval?.definitionSha256).toBe(draft.definitionSha256)
    await expect(plans.propose({ ...proposal, definition: definition('Other content') }, 'agent:session-a')).rejects.toMatchObject({ status: 409 })
    await expect(plans.propose(proposal, 'agent:session-b')).rejects.toMatchObject({ status: 409 })
    expect((await runtime.project(directory)).kernelState().state).toBe('cold')
    expect((await stat(join(directory,'.omicos-oss','research-plans.sqlite'))).mode & 0o777).toBe(0o600)
    await runtime.dispose(); runtime = await OssRuntime.open({ stateDir: join(directory,'state'), python: '/not-needed-for-plan-metadata' })
    const recovered = await runtime.researchPlans(directory); expect(recovered.get(draft.id)).toEqual(edit); expect(recovered.get(draft.id,2)).toEqual(approved)
  })
  it('pages all plans and history and rejects invalid definitions, cursors and concurrent revision updates', async () => {
    const plans = await runtime.researchPlans(directory)
    for (let index=0; index<56; index++) await plans.propose({ definition: definition(`Plan ${index}`), operationId: `create-${index}` }, 'user:workbench')
    const first = plans.list(); const second = plans.list('', first.next); expect(first.entries).toHaveLength(50); expect(second.entries).toHaveLength(6); expect(new Set([...first.entries,...second.entries].map(item=>item.id)).size).toBe(56)
    expect(plans.list('plan 0').entries).toHaveLength(1)
    let plan = plans.get(first.entries[0].id)
    const outcomes = await Promise.allSettled(['approve','reject'].map((action,index) => plans.decide(decide(plan,action as 'approve'|'reject',`compete-${index}`))))
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1); plan = plans.get(plan.id)
    for (let index=0; index<51; index++) plan = await plans.propose({ id: plan.id, revision: plan.revision, definition: definition(`revision ${index}`), operationId: `revision-${index}` }, 'user:workbench')
    const history = plans.history(plan.id); expect(history.revisions).toHaveLength(50); expect(plans.history(plan.id,history.next).revisions).toHaveLength(3)
    expect(()=>plans.list('',0)).toThrow(/cursor/); expect(()=>plans.get(plan.id,0)).toThrow(/cursor/)
    await expect(plans.propose({ definition: { ...definition(), steps: [definition().steps[0],definition().steps[0]] }, operationId: 'duplicate' }, 'user:workbench')).rejects.toThrow(/unique/)
    await expect(plans.decide(decide(plan,'complete','not-approved',{stepId:'inspect'}))).rejects.toThrow(/approved/)
    await expect(plans.propose({ id: '', definition: definition(), operationId: 'empty-id' }, 'user:workbench')).rejects.toMatchObject({ status: 400 })
    await expect(plans.propose({ revision: 3, definition: definition(), operationId: 'missing-id' }, 'user:workbench')).rejects.toMatchObject({ status: 400 })
    await expect(plans.decide(decide(plan,'approve','no-note',{note:''}))).rejects.toThrow(/note/)
  })
  it('checks actual source receipts, refuses failed/nonterminal work, orders tasks and invalidates downstream assessments on reopen', async () => {
    const jobs = new Map<string,Execution>(); const job = (id: string, state: Execution['state']): Execution => ({ id, state, operationId:id,sessionId:'s',language:'python',code:'value += 1',output:'42',createdAt:new Date().toISOString(),artifacts:[] })
    for (const state of ['succeeded','failed','interrupted','canceled','running'] as const) jobs.set(state,job(state,state))
    const plans = await ResearchPlans.open(directory,async source=>{ const job = jobs.get(source.executionId); if (!job) throw new Error('missing receipt'); return job }); stores.push(plans)
    let plan = await plans.propose({definition:definition(),operationId:'create'},'agent:session'); plan = await plans.decide(decide(plan,'approve','approve'))
    await expect(plans.decide(decide(plan,'complete','no-evidence',{stepId:'inspect'}))).rejects.toMatchObject({status:400})
    for (const state of ['failed','interrupted','canceled','running']) await expect(plans.decide(decide(plan,'complete',state,{stepId:'inspect',evidence:[{kind:'project',executionId:state}]}))).rejects.toMatchObject({status:409})
    await expect(plans.decide(decide(plan,'complete','out-of-order',{stepId:'report',evidence:[{kind:'project',executionId:'succeeded'}]}))).rejects.toThrow(/preceding/)
    plan = await plans.decide(decide(plan,'block','blocked',{stepId:'inspect',evidence:[{kind:'project',executionId:'failed'}]})); expect(plan.assessments[0].state).toBe('blocked')
    plan = await plans.decide(decide(plan,'complete','first',{stepId:'inspect',evidence:[{kind:'project',executionId:'succeeded'}]})); expect(plan.assessments[0].evidence[0].codeSha256).toMatch(/^[a-f0-9]{64}$/)
    const completeRevision = plan.revision
    plan = await plans.decide(decide(plan,'skip','skip',{stepId:'report'})); expect(plan.assessments.map(item=>item.state)).toEqual(['completed','skipped'])
    plan = await plans.decide(decide(plan,'reopen','reopen',{stepId:'inspect'})); expect(plan.assessments).toEqual([]); expect(plan.decisionStepId).toBe('inspect'); expect(plans.get(plan.id,completeRevision).assessments[0].state).toBe('completed')
    plan = await plans.decide(decide(plan,'withdraw','withdraw')); await expect(plans.decide(decide(plan,'complete','after-withdraw',{stepId:'inspect',evidence:[{kind:'project',executionId:'succeeded'}]}))).rejects.toMatchObject({status:409})
  })
  it('pins a real Python receipt, retains it after restart without executing code and resolves actual Pipeline receipts', async () => {
    await runtime.dispose(); runtime = await OssRuntime.open({ stateDir: join(directory,'state'), python: process.env.OMICOS_SCIENCE_TEST_PYTHON || 'python3' })
    const project = await runtime.project(directory); const execution = await project.submit('plan_counter = 42\nprint(plan_counter)','plan-actual','plan-test')
    const deadline = Date.now()+12000
    while (['queued','running'].includes(project.get(execution.id)!.state) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20))
    expect(project.get(execution.id)?.state).toBe('succeeded')
    let plans = await runtime.researchPlans(directory); let plan = await plans.propose({definition:definition(),operationId:'real-create'},'user:workbench'); plan = await plans.decide(decide(plan,'approve','real-approve'))
    plan = await plans.decide(decide(plan,'complete','real-complete',{stepId:'inspect',evidence:[{kind:'project',executionId:execution.id}]}))
    expect(plan.assessments[0].evidence[0].environment?.fingerprint).toBe(project.get(execution.id)?.environment?.fingerprint)
    const pipelines = await runtime.pipelines(directory); const pinned = pipelines.define({title:'Plan evidence',language:'python',steps:[{id:'only',code:'print(43)'}]}); let run = pipelines.start(pinned.id,'plan-pipeline')
    const pipelineDeadline = Date.now()+12000
    while (['preparing','running'].includes(run.state) && Date.now()<pipelineDeadline) { await new Promise(resolve=>setTimeout(resolve,20)); run = pipelines.get(run.id) }
    expect(run.state).toBe('succeeded'); const receipt = run.attempts[0].executionId!
    plan = await plans.decide(decide(plan,'complete','pipeline-complete',{stepId:'report',evidence:[{kind:'pipeline',runId:run.id,executionId:receipt}]}))
    expect(plan.assessments[1].evidence[0].runId).toBe(run.id)
    await runtime.dispose(); runtime = await OssRuntime.open({ stateDir: join(directory,'state'),python:'/must-not-execute' }); plans = await runtime.researchPlans(directory)
    expect(plans.get(plan.id)).toEqual(plan); expect((await runtime.project(directory)).kernelState().state).toBe('cold')
  },30000)
})
