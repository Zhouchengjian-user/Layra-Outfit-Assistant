export const sentryOptions = {
  // 错误事件保留完整采样；性能链路仅保守采样 1%。
  sampleRate: 1,
  tracesSampleRate: 0.01,
  sendDefaultPii: false,
  enableLogs: false,
  enableMetrics: false,
  maxBreadcrumbs: 0,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  },
};
