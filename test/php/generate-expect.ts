/**
 * @deprecated 预期结果只能通过 test-php-benchmark.ts 中的 updateExpect(dir) 更新。
 * 独立执行此脚本会绕过失败保护，可能用不完整结果覆盖 expect 文件。
 */

const message = [
  '[PHP Benchmark] generate-expect.ts 已废弃，拒绝执行。',
  '请在 test/php/test-php-benchmark.ts 中取消注释 // updateExpect(dir)，',
  '使用受失败保护的工作流更新 expect/phpbenchmark-expect.json。',
].join('\n')

console.error(message)
process.exitCode = 1
