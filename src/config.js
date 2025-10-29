module.exports = {
  //* *****************************  general ***************************
  YASA_MEMORY: 8192,
  envMode: 'debug', // debug|release
  fpRate: 'low', // false positive ra`te
  error_tolerance_factor: 5, // 0-10, the higher number means greater tolerance (0 for no tolerance, default is 5)

  //* ***************************** only dumpAST ***************************

  dumpAST: false, // dump ast to json format
  dumpAllAST: false, // dump all ast to json format

  //* *****************************  path and so on ***************************

  // output directory for trigger_lib files
  ASTFileOutput: '',
  reportDir: './report/',

  // log configuration
  logDir: './logs/yasa',
  // logLevel: 'info',

  //* *****************************  parsing *********************************
  // javascript | golang | java | python
  language: '',
  // EggAnalyzer | JavaScriptAnalyzer | JavaAnalyzer | SpringAnalyzer | GoAnalyzer | PythonAnalyzer
  analyzer: '',
  uastSDKPath: '',
  //* *****************************  subject  *********************************

  // ignored directories
  ignoredDirs: ['.git', 'libraries'],

  //* *****************************  runtime  *********************************
  // invoke the call-back functions if they appear in the arguments of a unknown function call
  // 0: don't invoke  1: invoke with ACL 2: always invoke
  invokeCallbackOnUnknownFunction: 1,

  // maximum execution time (in milliseconds) for a function-based iteration
  maxIterationTime: 4001,

  // multiple objects with the same source may share the same source line trace
  shareSourceLineSet: false,

  //* *****************************  analysis  ***************************

  stateUnionLevel: 2,

  //* *****************************  report  ***************************
  i18n: 'ch', // ch | en
  format: 'sarif', // sarif | json | plaintext | html
  dumpCG: false,
  needBenchmarkJson: true,
  //* ***************************** rules *****************
  loadDefaultRule: true,
  loadExternalRule: true,
  ruleConfigFile: '',
  checkerIds: [],
  checkerPackIds: [],
  entryPointAndSourceAtSameTime: true,
  entryPointMode: 'BOTH', // BOTH or ONLY_CUSTOM or SELF_COLLECT
}
