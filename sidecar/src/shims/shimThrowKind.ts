/**
 * 本目录里的文件为什么会抛出错误。
 *
 * `scripts/build-sidecar.mjs` 在打包时把一批 `src/**` 模块换成本目录里的文件。
 * 换上来的文件如果用抛出错误顶替了一段用户需要的功能，调用处又把错误吞掉，
 * 用户就会在毫无察觉的情况下丢失数据：用量记录曾经这样随版本发出去，
 * 约六周没有记上。
 *
 * 一个文件算作「会抛出错误」，是指下面任意一条成立：
 *   - 文件里有 `throw` 语句；
 *   - 文件里有 `Promise.reject(...)` 调用；
 *   - 文件用 `export … from '<相对路径>'` 转出的本地模块满足上面两条之一。
 *
 * 规则：
 *   - 本目录里会抛出错误的文件，必须导出
 *     `export const SHIM_THROW_KIND: ShimThrowKind = '...'`，值直接写成字符串字面量，
 *     并在常量上方写明这个文件每一处抛出错误的原因。
 *   - 其余文件不导出这个常量。
 *   - 只要有一处属于 `feature-gap`，整个文件就标 `feature-gap`。其余情况按文件里
 *     抛出错误的主要原因取值。
 *
 * 检查读的是语法，有两种情况它发现不了，写 shim 的人要自己把关：函数体什么都不做
 * 就返回；以及调用别的模块时由那个模块抛出的错误。
 *
 * 四个分类值：
 *   - `wiring-guard`：正确运行的 sidecar 走不到这里。走到了，说明依赖图或者宿主的
 *     注入接错了。
 *   - `shell-side`：调用得到，但要操作的东西只存在于 shell 进程，sidecar 里无论怎样
 *     实现都拿不到；这件事由 shell 自己完成，调用处已经容许这里失败。
 *   - `input-check`：文件是完整的实现。抛出错误是它正常行为的一部分：拒绝它不能
 *     照办的调用，或者把它实际执行的操作失败这件事报给调用方。
 *   - `feature-gap`：sidecar 缺少一段用户路径需要的能力，抛出错误会变成用户看不到的
 *     丢失。带这个值的文件不允许发版。
 *
 * 检查在两处：`shimSurfaceCoverage.test.ts` 断言上面的规则（随 `npm run verify`
 * 运行）；`scripts/release-preflight.mjs` 遇到 `feature-gap` 就让发版失败。两处都通过
 * `scripts/sidecar-shim-throw-kinds.mjs` 读取常量。
 */
export const SHIM_THROW_KINDS = ['wiring-guard', 'shell-side', 'input-check', 'feature-gap'] as const;

export type ShimThrowKind = (typeof SHIM_THROW_KINDS)[number];
