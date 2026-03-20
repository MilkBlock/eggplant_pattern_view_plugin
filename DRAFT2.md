# DRAFT2

## 项目反思

当前插件的能力边界是“对 pattern closure 中的 query graph 做可视化”。这对于 MVP 是成立的，但如果目标是帮助理解一条 eggplant rule 的完整语义，那么当前抽象明显过窄。至少有三个关键缺口：

1. 只有 `Pattern` 的可视化，没有 `action` 闭包的可视化。
2. 没有将 run rule 之前需要 commit 的节点或 seed facts 可视化。
3. `pattern` 中 assertion 的可视化存在语义错误，而且没有展示 assertion 的具体限制内容。

这些问题并不只是 DOT 层的表现问题，而是当前 IR 设计只覆盖了 rule 的一部分。

## 现状分析

### 1. 当前 extractor 只抽 pattern closure，不抽完整 rule

当前 scope 识别逻辑只把 `MyTx::add_rule(..., || { ... }, ...)` 的第 3 个参数当作支持范围，也就是 pattern closure。

相关位置：

- [eggplant-pattern-extractor/src/extractor.rs](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-extractor/src/extractor.rs#L57)
- [eggplant-pattern-extractor/src/extractor.rs](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-extractor/src/extractor.rs#L73)

这意味着：

- pattern closure 会被解析
- action closure 不会被解析
- `add_rule` 作为一个整体规则实体没有进入 IR

因此“没有 action 可视化”并不是漏画，而是 extractor 根本没有把 action 抽出来。

### 2. 当前 IR 只描述 pattern graph

Rust 侧和 TypeScript 侧的 IR 都只有这些字段：

- `nodes`
- `edges`
- `roots`
- `constraints`
- `diagnostics`

相关位置：

- [eggplant-pattern-extractor/src/ir.rs](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-extractor/src/ir.rs#L74)
- [eggplant-pattern-vscode/src/ir.ts](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-vscode/src/ir.ts#L39)

这里没有：

- action/effect 表达
- seed facts / committed facts
- assertion 的结构化依赖关系
- rule metadata

所以现在的插件本质上只是在画“query node DAG”，而不是在画“rule”。

## 问题一：缺少 action 闭包可视化

在 eggplant 真实规则里，action 才是“匹配成功后会发生什么”的核心。例如：

- `ctx.insert_const(cal)`
- `ctx.union(pat.p, op_value)`

见：

- [constant_prop.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/examples/constant_prop.rs#L29)

当前插件对这些完全无感，因此用户只能看到匹配条件，看不到推导结果、插入结果、union 行为，也就无法从图中理解 rule 的真正效果。

### 结论

需要把 action closure 纳入 extractor 的作用域，并在 IR 中增加 action/effect 子结构，而不是继续只围绕 `PatternIr` 做局部补丁。

## 问题二：缺少待 commit 节点 / seed facts 的可视化

在真实运行流程中，rule 不是凭空运行的。`run_rule` 或 `run_ruleset` 之前必须有已经 commit 的节点作为输入事实。

例如：

- `expr.commit();`

见：

- [constant_prop.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/examples/constant_prop.rs#L39)

如果没有这些 facts，pattern 本身并不能解释“这条 rule 将在什么图上触发”。因此：

- pattern graph 描述的是查询结构
- committed nodes / seed facts 描述的是待匹配输入

这两者应当都可视化，但它们不是同一种语义对象。

进一步从 eggplant 内部实现看，matcher 消费的并不只是 query node，还包括 table facts 和 constraint facts。

相关位置：

- [eggplant_backup/src/wrap/rule.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/src/wrap/rule.rs#L326)
- [eggplant_backup/src/instances/pat_rec.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/src/instances/pat_rec.rs#L309)

### 结论

这个插件后续最好拆出两种视图之一：

1. Rule View：显示 pattern、assertion、action。
2. Seed Facts View：显示 run 之前 commit 进去的节点和事实。

如果全部塞进同一张图，语义会混乱。更合理的做法是分别建模，再在 UI 上决定是否合并展示。

## 问题三：assertion 可视化语义错误

这是当前最直接的 bug。

### 现有实现

当前 extractor 会把 `.assert(...)` 的参数直接记成一个字符串 label：

- [eggplant-pattern-extractor/src/extractor.rs](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-extractor/src/extractor.rs#L290)

然后 DOT 生成时，会把每个 constraint note 用虚线连接到所有 root：

- [eggplant-pattern-vscode/src/dot.ts](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-vscode/src/dot.ts#L34)

### 为什么这是错的

假设代码是：

```rust
let l_r_eq = l.handle().eq(&r.handle());
MulPat::new(l, r, p).assert(l_r_eq)
```

当前图里显示的约束内容只会是 `l_r_eq`，而不会是：

```rust
l.handle().eq(&r.handle())
```

这带来两个问题：

1. 约束的具体内容丢失了。
2. 约束被错误地连接到所有 roots，而不是连接到它实际引用的变量，例如 `l` 和 `r`。

相关例子：

- [constrain_complex.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/examples/constrain_complex.rs#L26)
- [constrain_complex.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/examples/constrain_complex.rs#L56)

### 更深一层的问题

当前 root 提取只支持 `Pat::new(...)` 这一路径：

- [eggplant-pattern-extractor/src/extractor.rs](/Users/mineralsteins/Repos/egg_related/eggplant_pattern_view_plugin/eggplant-pattern-extractor/src/extractor.rs#L254)

但 eggplant 示例里还存在这种 pattern 返回形式：

```rust
{
    #[eggplant::pat_vars_catch]
    struct AddPat {
        l: Const,
        r: Const,
        p: Add,
    }
}
.assert(l_h_eq_r_h)
```

也就是 `pat_vars_catch struct` 再链式 `.assert(...)`。

见：

- [constrain_complex.rs](/Users/mineralsteins/Repos/egg_related/eggplant_backup/examples/constrain_complex.rs#L27)

这说明当前实现不仅 assertion 的显示不正确，连 assertion 挂接的宿主 pattern 都可能没有正确识别。

### 结论

assertion 不能只保留一个 `label: string`。它至少应当携带：

- 原始 assert 参数文本
- 如果参数是一个变量名，能够追溯它对应的 `let` 初始化表达式
- 该 assertion 引用到的 pattern variables 集合
- assertion 自身源码范围

在 DOT 层：

- assertion 应连接到它引用的变量节点，而不是所有 roots
- 显示文本应优先展示实际限制表达式，而不是中间变量名

## 设计方向

### 1. 作用域从 pattern closure 提升到 rule call

当前入口是“cursor 落在 pattern closure 里时，提取这个 closure”。

后续更合理的方式是：

- 当 cursor 位于 `MyTx::add_rule(...)` 的相关区域时
- 提取整个 `add_rule` 调用
- 分别分析 pattern closure 和 action closure

这样 IR 才能表达完整 rule。

### 2. IR 从 PatternIr 升级为 RuleIr

建议不要继续在现有 `PatternIr` 上堆字段，而是重构为更明确的结构，例如：

- `pattern_graph`
- `constraints`
- `action_effects`
- `seed_facts`
- `rule_meta`
- `diagnostics`

这样可以避免把不同语义层面的对象全部混在 `nodes` / `edges` 里。

### 3. assertion 使用结构化表示

建议 assertion 至少包含：

- `id`
- `source_text`
- `resolved_text`
- `referenced_vars`
- `range`

其中：

- `source_text` 是 `.assert(...)` 中原始传入的文本
- `resolved_text` 是在可能的情况下，把中间变量展开后的实际约束表达式
- `referenced_vars` 用于决定图上的连边

### 4. action 视图采用 effect graph

action 不一定适合伪装成 pattern node。更合理的方式是把 action 画成 effect graph，例如：

- `devalue(pat.l.num)`
- `devalue(pat.r.num)`
- `insert_const(cal)`
- `union(pat.p, op_value)`

它可以作为 pattern graph 右侧或下方的一个子图，并通过 `pat.*` 引用和 pattern 部分关联起来。

### 5. seed facts 单独建模

`expr.commit()` 这种输入事实建议不要强行混进 pattern graph。

更合理的做法是：

- 抽取 commit 前构造的表达式树
- 标明哪些 root 被 commit
- 作为 seed facts / input graph 展示

这部分可以成为单独视图，也可以作为 rule preview 的附加面板。

## 实现优先级建议

### 第一阶段：先修 assertion

这是最重要也最明确的问题，优先级最高。

目标：

- 正确识别 `.assert(...)`
- 展开约束变量引用
- 提取 assertion 依赖的变量
- 在 DOT 中正确连边
- 在图中显示具体限制表达式

### 第二阶段：补 action closure

目标：

- 扩展 extractor 到 `add_rule` 整体
- 抽取 action 中关键 effect
- 在图中展示 action 对 `pat.*` 的使用及其结果

### 第三阶段：补 seed facts / commit graph

目标：

- 识别 run 前的 commit 输入
- 可视化待推导 facts
- 明确区分 pattern graph 与 input graph

## 总结

当前插件的问题不是“少几个节点”这么简单，而是它现在只建模了 rule 的 pattern 侧，尚未建模：

- action
- seed facts
- assertion 的真实依赖结构

因此后续改造应以“从 Pattern View 升级到 Rule View”为目标，而不是只在现有 DOT 输出上追加几个 note。
