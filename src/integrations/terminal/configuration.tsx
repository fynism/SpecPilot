import { PasswordInput, Select, TextInput } from '@inkjs/ui';
import { Box, render, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import {
  type ApiProtocol,
  baseUrlSchema,
  type ConfigDraft,
  type Configuration,
  ConfigurationError,
  type UserConfig,
  userConfigSchema,
  writeUserConfig,
} from '../../config.js';
import { safeTerminalText } from './text.js';

const protocols = [
  { label: 'Anthropic 兼容协议', value: 'anthropic' },
  { label: 'OpenAI 兼容协议（暂未支持运行）', value: 'openai' },
];
const steps = ['选择 API 协议', '输入 Base URL', '输入模型 ID', '输入 API Key'];

/** 固定四步向导只维护草稿；持久化交给组合根提供的回调。 */
export function ConfigurationWizard({
  initial = {},
  onSave,
  onCancel,
}: {
  initial?: ConfigDraft;
  onSave(config: UserConfig): void;
  onCancel(): void;
}) {
  const [step, setStep] = useState(0);
  const [protocol, setProtocol] = useState<ApiProtocol>(initial.protocol ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(initial.base_url ?? '');
  const [model, setModel] = useState(initial.model ?? '');
  const [error, setError] = useState('');
  const finished = useRef(false);
  // 地址或协议变化后必须重新输入，不能把已有凭据无意发送给新的服务。
  const canKeepKey =
    !!initial.api_key?.trim() &&
    protocol === initial.protocol &&
    baseUrl.trim() === initial.base_url?.trim();
  useInput((input, key) => {
    if (finished.current) return;
    if (key.escape || (key.ctrl && input === 'c')) {
      finished.current = true;
      onCancel();
    } else if (step === 0) {
      if (key.upArrow) setProtocol('anthropic');
      else if (key.downArrow) setProtocol('openai');
      else if (key.return) setStep(1);
    }
  });

  function save(value: string) {
    if (finished.current) return;
    const result = userConfigSchema.safeParse({
      schema_version: 1,
      protocol,
      base_url: baseUrl,
      model,
      api_key: value.trim() || (canKeepKey ? initial.api_key : ''),
    });
    if (!result.success) {
      setError('API Key 不能为空或包含控制字符，请重新输入。');
      return;
    }
    try {
      onSave(result.data);
      finished.current = true;
    } catch (failure) {
      // 回调可能触及文件系统；仅展示已定义的安全错误，不能回显外部异常。
      setError(failure instanceof ConfigurationError ? failure.message : '配置保存失败，请重试。');
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        SpecPilot · API 配置
      </Text>
      <Text dimColor>仅配置第三方 API；Esc / Ctrl+C 取消，不改写原配置。</Text>
      <Text dimColor>Key 将以明文保存到用户配置，限制文件访问；不自动发送验证请求。</Text>
      <Text>
        {step + 1}/4 · {steps[step]}
      </Text>
      {step > 0 && <Text>协议：{protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}</Text>}
      {step > 1 && <Text>Base URL：{safeTerminalText(baseUrl)}</Text>}
      {step > 2 && <Text>模型 ID：{safeTerminalText(model)}</Text>}
      {step === 0 && (
        <Select
          key={protocol}
          isDisabled
          options={protocols}
          defaultValue={protocol}
          visibleOptionCount={2}
        />
      )}
      {step === 1 && (
        <>
          <Text dimColor>输入服务商提供的 HTTPS API Base URL，保留其路径前缀。</Text>
          <TextInput
            key="url"
            defaultValue={safeTerminalText(baseUrl)}
            placeholder="https://gateway.example/anthropic"
            onSubmit={(value) => {
              const parsed = baseUrlSchema.safeParse(value);
              if (!parsed.success) {
                setError('Base URL 必须是 HTTPS 地址，且不能包含账号、查询参数或片段。');
                return;
              }
              setBaseUrl(parsed.data);
              setError('');
              setStep(2);
            }}
          />
        </>
      )}
      {step === 2 && (
        <TextInput
          key="model"
          defaultValue={safeTerminalText(model)}
          placeholder="输入服务商提供的模型 ID"
          onSubmit={(value) => {
            const parsed = userConfigSchema.shape.model.safeParse(value);
            if (!parsed.success) {
              setError('模型 ID 不能为空或包含控制字符。');
              return;
            }
            setModel(parsed.data);
            setError('');
            setStep(3);
          }}
        />
      )}
      {step === 3 && (
        <>
          <Text dimColor>
            {canKeepKey
              ? '已有 API Key 已隐藏；留空保留，输入新 Key 则替换。'
              : '请输入 API Key，输入内容将隐藏；协议或 URL 变化时必须重新输入。'}
          </Text>
          <PasswordInput onSubmit={save} />
        </>
      )}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}

/** 使用独立终端生命周期，退出后销毁密码输入状态，不进入对话或 Session。 */
export async function runConfigurationWizard(
  configuration: Configuration,
): Promise<UserConfig | undefined> {
  let saved: UserConfig | undefined;
  const app = render(
    <ConfigurationWizard
      initial={configuration.user ?? configuration.draft}
      onSave={(config) => {
        writeUserConfig(config, configuration.path);
        saved = config;
        app.unmount();
      }}
      onCancel={() => app.unmount()}
    />,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    },
  );
  await app.waitUntilExit();
  return saved;
}

/** 展示配置来源，不展示密钥、原始文件或环境变量值。 */
export function configurationSourceText(configuration: Configuration): string {
  const labels = {
    workspace: '工作区 .env（同名变量优先于进程环境）',
    environment: '进程环境变量',
    user: '用户配置文件',
    none: '尚无完整配置',
  };
  return [`生效连接来源：${labels[configuration.source]}。`, ...configuration.overrides].join('\n');
}
