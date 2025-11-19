// .eslintrc.js
module.exports = {
  extends: [
    'airbnb-base',
    'plugin:sonarjs/recommended',
    'airbnb-typescript/base', // 添加 Airbnb TypeScript 扩展
    'prettier', // 禁用与 Prettier 冲突的 ESLint 规则
    'plugin:prettier/recommended', // 将 Prettier 作为 ESLint 的规则，一定放在最后
  ],
  parser: '@typescript-eslint/parser', // 指定 TypeScript 解析器
  parserOptions: {
    project: './tsconfig.json', // 指向你的 tsconfig 文件
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'prettier', 'sonarjs', 'jsdoc', 'filenames'],
  ignorePatterns: ['test/**', '**/test/**', 'node_modules/**', 'report/**'], // 忽略 test 目录及其子目录，防止变更测试代码影响单测

  rules: {
    // 自定义覆盖规则（可选）
    'no-console': 0,
    'no-restricted-syntax': 0,
    'no-underscore-dangle': 0,
    'no-use-before-define': 0,
    'no-param-reassign': 0,
    'global-require': 0,
    'class-methods-use-this': 0,
    'no-continue': 0,
    'guard-for-in': 0,
    'no-prototype-builtins': 0,
    'consistent-return': 0,
    'no-plusplus': 0,
    'no-unused-vars': 0,

    // TypeScript 专属规则调整
    '@typescript-eslint/consistent-type-imports': 'error', // 强制类型导入风格

    // Import 规则
    'import/no-commonjs': 'warn', // 推荐改成ES6
    'import/no-extraneous-dependencies': ['error', { devDependencies: true }], // 允许 devDependencies

    // Prettier 配置
    'prettier/prettier': ['error', { semi: false, singleQuote: true }], // 与 Prettier 配置同步

    // 文件命名规范（yasa 独有）
    'filenames/match-regex': [2, '^[a-z]+(-[a-z]+)*$', true],

    // JSDoc 规则 - 强制要求注释结构
    'jsdoc/require-jsdoc': [
      'error',
      {
        require: {
          FunctionDeclaration: true,
          MethodDefinition: true,
          ClassDeclaration: true,
        },
      },
    ],

    // JSDoc - 自动填充参数信息
    'jsdoc/require-param': 'error',
    'jsdoc/require-param-type': 'off', // TypeScript 已提供类型检查，无需重复
    'jsdoc/require-param-description': 'warn',

    // JSDoc - 自动填充返回信息
    'jsdoc/require-returns': 'error',
    'jsdoc/require-returns-type': 'error', // TypeScript 已提供返回类型

    // JSDoc - 自动填充描述信息
    'jsdoc/require-description': 'error',

    // JSDoc - 自动修复对齐
    'jsdoc/check-alignment': ['error', { tags: ['param', 'returns'] }],

    // 代码复杂度限制（yasa 独有）
    complexity: ['error', 15],
    'sonarjs/cognitive-complexity': ['warn', 15],
  },

  overrides: [
    {
      files: ['*.ts'], // 仅对 .ts 文件生效
      rules: {
        'no-undef': 'off', // TypeScript 已处理变量未定义检查
      },
    },
  ],
}
