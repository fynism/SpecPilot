import { z } from 'zod';
import {
  type ClarificationPresenter,
  clarificationInputSchema,
} from '../capabilities/clarification/models.js';
import { ClarificationService } from '../capabilities/clarification/tool.js';
import {
  listInputSchema,
  RepositoryReader,
  readInputSchema,
  searchInputSchema,
} from '../capabilities/repository/tool.js';
import { SpecExporter } from '../capabilities/spec/export.js';
import { patchSchema, type SpecToolService } from '../capabilities/spec/operations.js';
import type { HookDispatcher } from './contracts.js';
import { ToolRegistry } from './registry.js';

/** 默认目录保留八个公开工具，不开放 Shell 或仓库写入能力。 */
export function buildDefaultRegistry(
  root: string,
  spec: SpecToolService,
  presenter: ClarificationPresenter,
  dispatch: HookDispatcher,
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
  const clarification = new ClarificationService(presenter, dispatch);
  registry.register(
    'request_clarification',
    '针对一个高影响需求问题向用户提供 2 至 5 个选项、一个有依据的推荐项，并允许用户直接输入回答，或为选中的方向补充限制条件。',
    clarificationInputSchema,
    (i) => clarification.request(i),
  );
  const empty = z.strictObject({});
  registry.register('get_spec', '读取当前 Specification 最新版本的完整结构化事实。', empty, () =>
    spec.getSpec(),
  );
  registry.register(
    'apply_spec_patch',
    '通过一组带类型的语义操作原子更新当前 Specification；必须先用 get_spec 取得 expected_version，不能物理删除历史实体。',
    patchSchema,
    (i) => spec.applySpecPatch(i),
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
