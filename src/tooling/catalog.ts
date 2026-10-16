import { z } from 'zod';
import {
  type ClarificationPresenter,
  clarificationInputSchema,
} from '../capabilities/clarification/models.js';
import {
  ClarificationPlanError,
  type ClarificationPlanService,
  publishRoundSchema,
} from '../capabilities/clarification/plan.js';
import { ClarificationService } from '../capabilities/clarification/tool.js';
import {
  listInputSchema,
  RepositoryReader,
  readInputSchema,
  searchInputSchema,
} from '../capabilities/repository/tool.js';
import { SpecExporter } from '../capabilities/spec/export.js';
import {
  patchSchema,
  SpecMutationError,
  type SpecToolService,
} from '../capabilities/spec/operations.js';
import type { HookDispatcher } from './contracts.js';
import { ToolRegistry } from './registry.js';

/** 默认目录保留八个公开工具，不开放 Shell 或仓库写入能力。 */
export function buildDefaultRegistry(
  root: string,
  spec: SpecToolService,
  presenter: ClarificationPresenter,
  dispatch: HookDispatcher,
  plan?: ClarificationPlanService,
): ToolRegistry {
  const registry = new ToolRegistry();
  const repository = new RepositoryReader(root);
  registry.register(
    'list_repository_files',
    '列出仓库中的文件，用于低成本了解目录结构；不会读取文件正文。',
    listInputSchema,
    (i) => repository.listFiles(i),
  );
  registry.register(
    'search_repository',
    '在仓库的 UTF-8 文本文件中搜索普通字符串，并返回文件、行号和片段。',
    searchInputSchema,
    (i) => repository.search(i),
  );
  registry.register(
    'read_repository_file',
    '读取仓库内一个 UTF-8 文本文件的指定行范围；不能访问仓库外路径。',
    readInputSchema,
    (i) => repository.readFile(i),
  );
  if (plan) {
    registry.register(
      'get_clarification_plan',
      '读取当前澄清总览、轮次、真实回答历史与待复核事项。',
      z.strictObject({}),
      () => JSON.stringify(plan.get()),
    );
    registry.register(
      'publish_clarification_round',
      '按预期版本更新完整总览并发布一至三个本轮关键问题；按依赖和优先级自适应，不填充问题。保留所有旧 ID。此工具不会等待用户，成功后立即结束本轮，必须最后调用。解决问题必须关联真实证据；不得把推荐当作回答。',
      publishRoundSchema,
      (i) => {
        try {
          return plan.publish(i);
        } catch (error) {
          if (!(error instanceof ClarificationPlanError)) throw error;
          return JSON.stringify({
            status: 'error',
            code: 'invalid_clarification_plan',
            message: error.message,
          });
        }
      },
    );
  } else {
    const clarification = new ClarificationService(presenter, dispatch);
    registry.register(
      'request_clarification',
      '针对一个高影响需求问题向用户提供 2 至 5 个选项、一个有依据的推荐项，并允许用户直接输入回答，或为选中的方向补充限制条件。',
      clarificationInputSchema,
      (i) => clarification.request(i),
    );
  }
  const empty = z.strictObject({});
  registry.register('get_spec', '读取当前 Specification 最新版本的完整结构化事实。', empty, () =>
    spec.getSpec(),
  );
  registry.register(
    'apply_spec_patch',
    '通过语义操作原子更新 Specification；先 get_spec 取得 expected_version。不能物理删除历史实体或改写 Evidence。真实澄清提交已有宿主证据，按 locator 引用其 Evidence ID，不必重新 record_evidence。',
    patchSchema,
    (i) => {
      try {
        return spec.applySpecPatch(i);
      } catch (error) {
        if (!(error instanceof SpecMutationError)) throw error;
        return JSON.stringify({ status: 'error', code: error.code, message: error.message });
      }
    },
  );
  registry.register(
    'validate_spec',
    '确定性检查当前 Specification 的目标、阻塞问题和需求验收覆盖，返回是否具备进入人工批准阶段的条件。',
    empty,
    () => spec.validateSpec(),
  );
  const exporter = new SpecExporter(root);
  registry.register(
    'export_spec',
    '把当前结构化 Specification 导出到工作区固定目录中的 spec.json 和 SPEC.md。',
    empty,
    () => exporter.export(spec.currentSpec()),
  );
  return registry;
}
