import { stripVTControlCharacters } from 'node:util';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ConfigDraft, ConfigurationError, type UserConfig } from '../src/config.js';
import { ConfigurationWizard } from '../src/integrations/terminal/configuration.js';

afterEach(cleanup);
type Screen = ReturnType<typeof render>;
const selectedOpenAI = /OpenAI 兼容协议（暂未支持运行） [√✔]/;
async function frame(screen: Screen, text: string | RegExp) {
  await vi.waitFor(() => {
    const visible = stripVTControlCharacters(screen.lastFrame() ?? '');
    if (typeof text === 'string') expect(visible).toContain(text);
    else expect(visible).toMatch(text);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function enter(screen: Screen, next: string) {
  screen.stdin.write('\r');
  await frame(screen, next);
}
async function start(initial: ConfigDraft = {}, onSave = vi.fn<(config: UserConfig) => void>()) {
  const onCancel = vi.fn();
  const screen = render(
    <ConfigurationWizard initial={initial} onSave={onSave} onCancel={onCancel} />,
  );
  await frame(screen, '1/4');
  return { screen, onSave, onCancel };
}
const existing: UserConfig = {
  schema_version: 1,
  protocol: 'anthropic',
  base_url: 'https://gateway.example/proxy/v1',
  model: 'my-model',
  api_key: 'existing-secret',
};

describe('四步 API 配置向导', () => {
  it('按协议、URL、模型、Key 顺序接受输入，粘贴的 Key 从不显示', async () => {
    const { screen, onSave } = await start();
    await enter(screen, '2/4');
    screen.stdin.write('https://gateway.example/proxy/v1');
    await frame(screen, 'https://gateway.example/proxy/v1');
    await enter(screen, '3/4');
    screen.stdin.write('my-model');
    await frame(screen, 'my-model');
    await enter(screen, '4/4');
    screen.stdin.write('pasted-private-key');
    await frame(screen, '******************');
    screen.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ...existing, api_key: 'pasted-private-key' }),
    );
    expect(screen.frames.join('\n')).not.toContain('pasted-private-key');
    expect(screen.frames.join('\n')).not.toContain(existing.api_key);
  });

  it('编辑时可以保留 Key，模型变化不影响凭据', async () => {
    const { screen, onSave } = await start(existing);
    await enter(screen, '2/4');
    await enter(screen, '3/4');
    screen.stdin.write('-updated');
    await frame(screen, 'my-model-updated');
    await enter(screen, '留空保留');
    screen.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ...existing, model: 'my-model-updated' }),
    );
    expect(screen.frames.join('\n')).not.toContain(existing.api_key);
  });

  it.each(['protocol', 'url'])('修改 %s 后空 Key 不得复用旧凭据', async (change) => {
    const { screen, onSave } = await start(existing);
    if (change === 'protocol') {
      screen.stdin.write('\u001b[B');
      await frame(screen, selectedOpenAI);
    }
    await enter(screen, '2/4');
    if (change === 'url') {
      screen.stdin.write('/other');
      await frame(screen, `${existing.base_url}/other`);
    }
    await enter(screen, '3/4');
    await enter(screen, '必须重新输入');
    screen.stdin.write('\r');
    await frame(screen, 'API Key 不能为空');
    expect(onSave).not.toHaveBeenCalled();
    screen.stdin.write('replacement-key');
    await frame(screen, '***************');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      api_key: 'replacement-key',
      protocol: change === 'protocol' ? 'openai' : 'anthropic',
      base_url: change === 'url' ? `${existing.base_url}/other` : existing.base_url,
    });
  });

  it('已保存 OpenAI 可以直接确认协议，并能替换已有 Key', async () => {
    const { screen, onSave } = await start({ ...existing, protocol: 'openai' });
    expect(stripVTControlCharacters(screen.lastFrame() ?? '')).toMatch(selectedOpenAI);
    await enter(screen, '2/4');
    await enter(screen, '3/4');
    await enter(screen, '4/4');
    screen.stdin.write('new-key');
    await frame(screen, '*******');
    screen.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ ...existing, protocol: 'openai', api_key: 'new-key' }),
    );
  });

  it('非法 URL 和空模型不推进，错误不回显输入', async () => {
    const { screen, onSave } = await start();
    await enter(screen, '2/4');
    screen.stdin.write('http://gateway.example');
    await frame(screen, 'http://gateway.example');
    await enter(screen, 'Base URL 必须是 HTTPS');
    expect(screen.lastFrame()).toContain('2/4');
    expect(onSave).not.toHaveBeenCalled();
    screen.unmount();
    const next = await start({ base_url: existing.base_url });
    await enter(next.screen, '2/4');
    await enter(next.screen, '3/4');
    await enter(next.screen, '模型 ID 不能为空');
    expect(next.screen.lastFrame()).toContain('3/4');
    expect(next.onSave).not.toHaveBeenCalled();
  });

  it.each(['\u001b', '\u0003'])('取消按键 %j 不保存草稿', async (key) => {
    const { screen, onSave, onCancel } = await start(existing);
    await enter(screen, '2/4');
    await enter(screen, '3/4');
    await enter(screen, '4/4');
    screen.stdin.write('unsaved-secret');
    await frame(screen, '**************');
    screen.stdin.write(key);
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.frames.join('\n')).not.toContain('unsaved-secret');
  });

  it('保存失败停留在 Key 步骤，安全提示后可以重试，重复确认不会重复保存', async () => {
    const onSave = vi.fn<(config: UserConfig) => void>().mockImplementationOnce(() => {
      throw new ConfigurationError('无法安全保存用户配置');
    });
    const { screen } = await start(existing, onSave);
    await enter(screen, '2/4');
    await enter(screen, '3/4');
    await enter(screen, '4/4');
    await enter(screen, '无法安全保存用户配置');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    screen.stdin.write('\r');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('未知保存异常不回显外部错误正文', async () => {
    const onSave = vi.fn<(config: UserConfig) => void>(() => {
      throw new Error(existing.api_key);
    });
    const { screen } = await start(existing, onSave);
    await enter(screen, '2/4');
    await enter(screen, '3/4');
    await enter(screen, '4/4');
    await enter(screen, '配置保存失败，请重试');
    expect(screen.frames.join('\n')).not.toContain(existing.api_key);
  });
});
