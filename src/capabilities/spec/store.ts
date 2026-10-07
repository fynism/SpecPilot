import { type Clock, type Specification, specificationSchema, utcNow } from './models.js';

/** 单进程版本历史；只返回隔离副本，保存时复验而非信任 TypeScript 类型。 */
export class InMemorySpecStore {
  private readonly records = new Map<string, Specification[]>();
  constructor(private readonly clock: Clock = utcNow) {}

  static fromHistory(history: Specification[], clock: Clock = utcNow): InMemorySpecStore {
    const first = history[0];
    if (
      !first ||
      history.some((s, i) => s.spec_id !== history[0]?.spec_id || s.version !== i + 1)
    ) {
      throw new Error('Spec 历史必须属于同一 ID，并从 1 连续递增');
    }
    const store = new InMemorySpecStore(clock);
    store.records.set(
      first.spec_id,
      history.map((s) => specificationSchema.parse(s)),
    );
    return store;
  }

  create(input: Specification): Specification {
    const spec = specificationSchema.parse(input);
    if (this.records.has(spec.spec_id) || spec.version !== 1)
      throw new Error('Spec 已存在或初始版本不是 1');
    this.records.set(spec.spec_id, [spec]);
    return structuredClone(spec);
  }

  get(id: string, version?: number): Specification {
    const history = this.history(id);
    const spec =
      version === undefined ? history.at(-1) : history.find((s) => s.version === version);
    if (!spec) throw new Error(`Spec 版本不存在：${id} · ${version}`);
    return spec;
  }

  save(input: Specification, expectedVersion: number): Specification {
    const spec = specificationSchema.parse(input);
    const current = this.get(spec.spec_id);
    if (current.version !== expectedVersion || spec.version !== expectedVersion)
      throw new Error('Spec 版本冲突');
    if (spec.created_at !== current.created_at) throw new Error('不能修改 Spec 创建时间');
    const saved = specificationSchema.parse({
      ...spec,
      version: expectedVersion + 1,
      updated_at: this.clock(),
    });
    const history = this.records.get(spec.spec_id);
    if (!history) throw new Error('Spec 历史不存在');
    history.push(saved);
    return structuredClone(saved);
  }

  history(id: string): Specification[] {
    const history = this.records.get(id);
    if (!history) throw new Error(`Spec 不存在：${id}`);
    return structuredClone(history);
  }
}
