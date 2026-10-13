import { describe, expect, it } from 'vitest';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import { runSessionTurn } from '../src/runtime/turn.js';
import { call, recommendedPresenter, ScriptedClient, temporaryManager } from './helpers.js';
import { answer, initialRound } from './round-helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
function runtime(manager: SessionManager, root: string, client: ScriptedClient) {
  return buildSessionRuntime(
    manager,
    root,
    settings,
    recommendedPresenter,
    () => undefined,
    client,
  );
}
describe('默认 Runtime 多轮边界', () => {
  it('发布立即返回，同批后续调用配对拒绝；默认不暴露阻塞单题工具', async () => {
    const f = temporaryManager();
    try {
      const client = new ScriptedClient([
        [
          call('publish', 'publish_clarification_round', initialRound()),
          call('later', 'list_repository_files'),
        ],
      ]);
      expect(
        await runSessionTurn(f.manager, runtime(f.manager, f.root, client), '做文件上传'),
      ).toBe('clarification_round_ready');
      expect(client.exposedTools).toHaveLength(1);
      expect(client.exposedTools[0]!.map((t) => t.name)).not.toContain('request_clarification');
      const last = f.manager.messages.at(-1)!.content;
      expect(last).toMatchObject([
        { tool_use_id: 'publish' },
        { tool_use_id: 'later', content: expect.stringContaining('拒绝') },
      ]);
      answer(f.manager, 'files');
      f.manager.deferClarification('users', true);
      expect(client.exposedTools).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  it('失败和进程中断保留提交，回退部分总览与 Spec，并显式重试', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      const query = f.manager.submitClarification('submit_one')!;
      const client = new ScriptedClient([[call('get', 'get_spec')]]);
      await expect(
        runSessionTurn(f.manager, runtime(f.manager, f.root, client), query),
      ).rejects.toThrow();
      expect(f.manager.current.status).toBe('interrupted');
      expect(f.manager.clarification.get().submissions[0]?.status).toBe('retry');
      const revived = new SessionManager(new LocalSessionStore(f.root));
      revived.start();
      expect(revived.clarification.get().answers).toHaveLength(1);
      expect(JSON.parse(revived.retryClarification()).submission.id).toBe('submit_one');
      revived.beginTurn('重试');
      const restarted = new SessionManager(new LocalSessionStore(f.root));
      restarted.start();
      expect(restarted.current.status).toBe('interrupted');
      expect(restarted.clarification.get().submissions[0]?.status).toBe('retry');
    } finally {
      f.cleanup();
    }
  });
  it('/done 无工具、不提交草稿、不修改 Spec；发布失败不会错误结束轮次', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      const before = f.manager.currentSpec();
      const client = new ScriptedClient([
        [call('forbidden', 'get_spec')],
        [{ type: 'text', text: '未决事项保留' }],
      ]);
      await runSessionTurn(f.manager, runtime(f.manager, f.root, client), '/done');
      expect(client.exposedTools.every((tools) => tools.length === 0)).toBe(true);
      expect(f.manager.currentSpec()).toEqual(before);
      expect(f.manager.clarification.get().answers[0]?.submission_id).toBeNull();
      const invalid = new ScriptedClient([
        [call('bad', 'publish_clarification_round', initialRound())],
        [{ type: 'text', text: '版本冲突' }],
      ]);
      expect(await runSessionTurn(f.manager, runtime(f.manager, f.root, invalid), '继续')).toBe(
        'model_complete',
      );
    } finally {
      f.cleanup();
    }
  });
  it('已提交但尚未运行时选择结束，最终总结不能补写 Spec 证据', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      f.manager.submitClarification('submit_one');
      const before = f.manager.currentSpec();
      const client = new ScriptedClient([[{ type: 'text', text: '已提交但尚未处理的事项保留' }]]);
      await runSessionTurn(f.manager, runtime(f.manager, f.root, client), '/done');
      expect(f.manager.currentSpec()).toEqual(before);
    } finally {
      f.cleanup();
    }
  });
});
