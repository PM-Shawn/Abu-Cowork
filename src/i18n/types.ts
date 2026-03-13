/**
 * i18n Type Definitions
 * Provides full type safety and IDE autocompletion for translations
 */

export type SupportedLocale = 'zh-CN' | 'en-US';
export type LanguageSetting = 'system' | SupportedLocale;

/**
 * Translation dictionary interface
 * Organized by component/feature for maintainability
 */
export interface TranslationDict {
  // Common/Shared
  common: {
    appName: string;
    appSlogan: string;
    windowTitle: string;
    version: string;
    close: string;
    cancel: string;
    confirm: string;
    save: string;
    delete: string;
    search: string;
    loading: string;
    comingSoon: string;
  };

  // Sidebar
  sidebar: {
    newTask: string;
    scheduledTasks: string;
    triggers: string;
    toolbox: string;
    recents: string;
    noSessionsYet: string;
    hideSidebar: string;
    showSidebar: string;
    scheduled: string;
    noScheduledRuns: string;
    exportConversation: string;
    deleteConversation: string;
    conversationDeleted: string;
    undo: string;
    importSession: string;
    renameConversation: string;
    viewScheduledTask: string;
    archiveRun: string;
    triggered: string;
    viewTrigger: string;
    archiveTriggerRun: string;
    help: string;
    editProfile: string;
    nickname: string;
    nicknamePlaceholder: string;
    avatar: string;
    changeAvatar: string;
    defaultNickname: string;
    resetProfile: string;
  };

  // Chat/Welcome
  chat: {
    inputPlaceholder: string;
    inputPlaceholderBusy: string;
    inputPlaceholderWithSkill: string;
    inputPlaceholderWithAgent: string;
    inputPlaceholderMidTask: string;
    start: string;
    stop: string;
    welcomeTitle: string;
    welcomeSubtitle: string;
    disclaimer: string;
    thinking: string;
    dropFilesHere: string;
    pasteOrDropImages: string;
    imageAdded: string;
    removeImage: string;
    openInFinder: string;
    openInBrowser: string;
    clickToPreview: string;
    sources: string;
    showAllSources: string;
    collapseSources: string;
    scrollToBottom: string;
    codeBlockExpand: string;
    codeBlockCollapse: string;
    codeBlockSaveAs: string;
    setupRequired: string;
    setupRequiredDesc: string;
    setupButton: string;
    // MessageBubble
    thinkingProcess: string;
    copy: string;
    edit: string;
    regenerate: string;
    saveAndResend: string;
    clickToViewFull: string;
    inputTokens: string;
    outputTokens: string;
    addAttachment: string;
    // Scenario guide
    trySaying: string;
    scenarios: Record<string, string>;
    scenarioPlaceholders: Record<string, string>;
    scenarioPrompts: Record<string, string>;
    /** Full prompt sent on click (falls back to scenarioPrompts if absent) */
    scenarioFullPrompts: Record<string, string>;
  };

  // Status Bar
  status: {
    ready: string;
    thinking: string;
    responding: string;
    usingTool: string;
  };

  // Task Block
  task: {
    processing: string;
    completed: string;
    createdFile: string;
    createdFiles: string;
    modifiedFile: string;
    modifiedFiles: string;
    readFile: string;
    readFiles: string;
    executedCommand: string;
    executedCommands: string;
    calledTool: string;
    calledTools: string;
    executedOperations: string;
    thoughtFor: string;
    executedIn: string;
    result: string;
    retryAction: string;
    errorOccurred: string;
    delegatedTo: string;
    agentProcessing: string;
    // Step type labels
    typeRead: string;
    typeWrite: string;
    typeCreate: string;
    typeScript: string;
    typeSkill: string;
    typeDelegate: string;
    typeTool: string;
    typeSearch: string;
    input: string;
    output: string;
    done: string;
    running: string;
    showMore: string;
    collapse: string;
  };

  // Settings Modal
  settings: {
    title: string;
    apiConfig: string;
    modelSelect: string;
    advanced: string;
    pressEscToClose: string;
    // API Section
    provider: string;
    providerAnthropic: string;
    providerOpenAI: string;
    providerLocal: string;
    apiProtocol: string;
    openaiCompatible: string;
    anthropicNative: string;
    openaiCompatibleDesc: string;
    anthropicNativeDesc: string;
    apiUrl: string;
    apiUrlHint: string;
    apiUrlDesc: string;
    apiKey: string;
    apiKeyPlaceholder: string;
    apiKeyDesc: string;
    // Model Section
    model: string;
    customModelOption: string;
    customModelName: string;
    customModelPlaceholder: string;
    customModelDesc: string;
    currentModel: string;
    notSet: string;
    // Advanced Section
    baseUrl: string;
    baseUrlPlaceholder: string;
    apiFormat: string;
    selectModel: string;
    customModel: string;
    temperature: string;
    temperaturePrecise: string;
    temperatureCreative: string;
    temperatureDescription: string;
    extendedThinking: string;
    extendedThinkingDescription: string;
    thinkingBudget: string;
    thinkingBudgetFast: string;
    thinkingBudgetDeep: string;
    // Language
    language: string;
    languageDescription: string;
    followSystem: string;
    // Image Generation
    imageGen: string;
    imageGenDescription: string;
    imageGenApiKey: string;
    imageGenApiKeyPlaceholder: string;
    imageGenApiKeyDesc: string;
    imageGenBaseUrl: string;
    imageGenBaseUrlPlaceholder: string;
    imageGenBaseUrlDesc: string;
    imageGenModel: string;
    imageGenCustomModel: string;
    // Web Search
    webSearch: string;
    webSearchDescription: string;
    webSearchProvider: string;
    webSearchApiKey: string;
    webSearchApiKeyPlaceholder: string;
    webSearchApiKeyDesc: string;
    webSearchBaseUrl: string;
    webSearchBaseUrlPlaceholder: string;
    webSearchBaseUrlDesc: string;
    webSearchProviderBing: string;
    webSearchProviderBrave: string;
    webSearchProviderTavily: string;
    webSearchProviderSearXNG: string;
    // AI Services
    aiServices: string;
    aiServicesDescription: string;
    capabilities: string;
    capabilityChat: string;
    capabilityWebSearch: string;
    capabilityImageGen: string;
    builtinSupported: string;
    builtinNotSupported: string;
    useBuiltinSearch: string;
    useBuiltinSearchDesc: string;
    configCustomSearch: string;
    configCustomImageGen: string;
    // Sandbox
    sandbox: string;
    sandboxDescription: string;
    sandboxEnabled: string;
    sandboxDisabled: string;
    sandboxProtection: string;
    sandboxProtectionDescription: string;
    sandboxMacOSOnly: string;
    sandboxAppLayerProtection: string;
    sandboxProtectedPaths: string;
    sandboxWritablePaths: string;
    sandboxDisableWarning: string;
    // Network isolation
    networkIsolation: string;
    networkIsolationDescription: string;
    allowPrivateNetworks: string;
    networkWhitelist: string;
    networkPreset: string;
    networkCustom: string;
    // General section
    general: string;
    generalDescription: string;
    closeWindowBehavior: string;
    closeWindowAsk: string;
    closeWindowAskDesc: string;
    closeWindowMinimize: string;
    closeWindowMinimizeDesc: string;
    closeWindowQuit: string;
    closeWindowQuitDesc: string;
    // Behavior sensor
    behaviorSensor: string;
    behaviorSensorDesc: string;
    behaviorSensorClearData: string;
    behaviorSensorCleared: string;
    behaviorSensorPermissionDenied: string;
    behaviorSensorPermissionGuide: string;
    computerUse: string;
    computerUseDesc: string;
    computerUsePermissionDenied: string;
    computerUsePermissionGuide: string;
    // ModelConfigSection
    currentConfig: string;
    configured: string;
    notConfigured: string;
    selectProvider: string;
    selectPlaceholder: string;
    autoSaved: string;
  };

  // Toolbox Modal
  toolbox: {
    title: string;
    skills: string;
    agents: string;
    mcp: string;
    searchPlaceholder: string;
    footerDescription: string;
    // Skills Section
    installedSkills: string;
    noInstalledSkills: string;
    skillMarketplace: string;
    createSkill: string;
    createWithAbu: string;
    createManually: string;
    nameFormatHint: string;
    aiAssistedCreate: string;
    installFailed: string;
    // Agents Section
    installedAgents: string;
    noInstalledAgents: string;
    agentMarketplace: string;
    createAgent: string;
    mainAgent: string;
    defaultAgent: string;
    mainAgentDesc: string;
    // MCP Section
    mcpServers: string;
    configuredServers: string;
    addServer: string;
    addCustomServer: string;
    noServersConfigured: string;
    noServersConnected: string;
    myServers: string;
    exampleServers: string;
    serverName: string;
    serverCommand: string;
    serverArgs: string;
    transportType: string;
    transportStdio: string;
    transportHttp: string;
    serverUrl: string;
    serverUrlPlaceholder: string;
    serverHeaders: string;
    serverHeadersPlaceholder: string;
    serverTimeout: string;
    connected: string;
    connecting: string;
    reconnecting: string;
    disconnected: string;
    connect: string;
    disconnect: string;
    add: string;
    install: string;
    uninstall: string;
    installed: string;
    installAndConnect: string;
    popularMCPServices: string;
    setupWithAbu: string;
    aiAssistedMCPSetup: string;
    // Source labels
    sourceBuiltin: string;
    sourceProject: string;
    sourceUser: string;
    sourceUnknown: string;
    builtinSkills: string;
    builtinAgents: string;
    noSkillsFound: string;
    noAgentsFound: string;
    systemSkills: string;
    customSkills: string;
    noCustomSkills: string;
    // Customize Panel
    customize: string;
    customizeFooter: string;
    models: string;
    // ModelsSection
    currentConfig: string;
    quickSwitch: string;
    current: string;
    configured: string;
    notConfigured: string;
    localModels: string;
    openaiCompatible: string;
    qiniuCloud: string;
    openrouter: string;
    deepseek: string;
    anthropic: string;
    volcengine: string;
    bailian: string;
    advancedSettings: string;
    advancedSettingsDesc: string;
    // Sub-tab labels
    tabSystem: string;
    tabCustom: string;
    tabConnected: string;
    tabConfigured: string;
    tabRecommended: string;
    createMCP: string;
    uploadFile: string;
    uploadSuccess: string;
    uploadFailed: string;
    uploadFileCount: string;
    exportSkill: string;
    exportSuccess: string;
    exportFailed: string;
    manualAdd: string;
    // Skill detail & editor
    skillDetail: string;
    skillTrigger: string;
    skillDoNotTrigger: string;
    skillTags: string;
    skillAllowedTools: string;
    skillContext: string;
    skillContextInline: string;
    skillContextFork: string;
    skillMaxTurns: string;
    skillContent: string;
    skillEnabled: string;
    skillDisabled: string;
    skillEdit: string;
    skillTryInChat: string;
    skillSave: string;
    skillSaveAndTest: string;
    skillEditorTitle: string;
    skillEditorName: string;
    skillEditorDescription: string;
    skillEditorDescriptionPlaceholder: string;
    skillEditorMetadata: string;
    skillEditorContent: string;
    skillEditorPreview: string;
    skillArgumentHint: string;
    skillUserInvocable: string;
    skillDisableAutoInvoke: string;
    skillLicense: string;
    skillAdvancedSettings: string;
    skillFiles: string;
    skillAddedBy: string;
    mySkills: string;
    exampleSkills: string;
    activeSkills: string;
    activeSkillsRemove: string;
    // Category filter
    categoryAll: string;
    categoryDocument: string;
    categoryDesign: string;
    categoryDevelopment: string;
    // Agent detail & editor
    agentDetail: string;
    agentModel: string;
    agentModelInherit: string;
    agentTools: string;
    agentDisallowedTools: string;
    agentSkills: string;
    agentMemory: string;
    agentMemorySession: string;
    agentMemoryProject: string;
    agentMemoryUser: string;
    agentMaxTurns: string;
    agentBackground: string;
    agentAvatar: string;
    agentSystemPrompt: string;
    agentEdit: string;
    agentSave: string;
    agentSaveAndTest: string;
    agentEditorTitle: string;
    agentEditorName: string;
    agentEditorDescription: string;
    agentEditorMetadata: string;
    agentEditorContent: string;
    agentEditorPreview: string;
    myAgents: string;
    exampleAgents: string;
    agentEnabled: string;
    agentDisabled: string;
    agentCategoryAll: string;
    agentCategoryResearch: string;
    agentCategoryDevelopment: string;
    agentCategoryWriting: string;
    noCustomAgents: string;
    // Connection test
    testConnection: string;
    testSuccess: string;
    testFailed: string;
    testing: string;
    // Tool count
    toolCount: string;
    noTools: string;
    // Server logs
    viewLogs: string;
    noLogs: string;
    // MarketplaceCard i18n
    installing: string;
    aiCreateAgentPrompt: string;
    aiCreateSkillPrompt: string;
    agentTestPrompt: string;
    // JSON config import
    formMode: string;
    jsonMode: string;
    jsonConfigLabel: string;
    jsonConfigPlaceholder: string;
    jsonConfigHint: string;
    jsonConfigInvalid: string;
    jsonConfigEmpty: string;
  };

  // Permission Dialog
  permission: {
    workspace: {
      title: string;
      description: string;
      capabilities: string[];
      warning: string;
    };
    shell: {
      title: string;
      description: string;
      capabilities: string[];
      warning: string;
    };
    fileWrite: {
      title: string;
      description: string;
      capabilities: string[];
      warning: string;
    };
    fileRead?: {
      title: string;
      description: string;
      capabilities: string[];
      warning: string;
    };
    folderSelect?: {
      title: string;
      description: string;
      selectButton: string;
      hint: string;
      authorizeTitle: string;
      authorizeDescription: string;
      authorizeButton: string;
      chooseDifferent: string;
      authorizeCapabilities: string[];
      authorizeWarning: string;
    };
    abuCanDo: string;
    allowOnce: string;
    allowAlways: string;
    deny: string;
    rememberChoice: string;
    rememberChoiceDescription: string;
    forgetAfterSession: string;
    // Duration options
    durationOnce: string;
    durationSession: string;
    duration24h: string;
    durationAlways: string;
    durationAlwaysConfirm: string;
    // Button labels per duration
    durationLabel: string;
    allowOnceButton: string;
    allowSessionButton: string;
    allow24hButton: string;
    allowAlwaysButton: string;
  };

  // Panels
  panel: {
    workspace: string;
    files: string;
    preview: string;
    noWorkspaceSelected: string;
    selectWorkspace: string;
    noFilesModified: string;
    selectWorkspaceHint: string;
    recentlyUsed: string;
    selectOtherFolder: string;
    instructionFile: string;
    openInFinder: string;
    closePreview: string;
    previewMode: string;
    sourceMode: string;
    unsupportedFileType: string;
    showInFinder: string;
    failedToReadFile: string;
    fileNotFound: string;
    // FilesSection
    operationRead: string;
    operationModify: string;
    operationCreate: string;
    clickToPreview: string;
    showInFinderButton: string;
    noReferencedFiles: string;
    filesCount: string;
    addFile: string;
    // RightPanel
    details: string;
    hidePanel: string;
    showPanel: string;
    // TaskProgressPanel
    progress: string;
    progressEmptyHint: string;
    // ContextSection
    context: string;
    contextEmptyHint: string;
    accessedFiles: string;
    toolUsage: string;
    moreFiles: string;
    collapse: string;
    connectors: string;
    refreshing: string;
    // Preview: PDF
    pdfPage: string;
    pdfZoomIn: string;
    pdfZoomOut: string;
    pdfPrevPage: string;
    pdfNextPage: string;
    // Preview: XLSX
    xlsxSheetLabel: string;
    xlsxRowsShowing: string;
    // Preview: CSV
    csvNoData: string;
    // Preview: common
    loadingDocument: string;
  };

  // Folder Selector
  folder: {
    selectFolder: string;
    selectWorkspaceFolder: string;
    recentFolders: string;
    browse: string;
    clearWorkspace: string;
    loadFolder: string;
    selectOtherFolder: string;
  };

  // Scheduled Tasks
  schedule: {
    title: string;
    newTask: string;
    editTask: string;
    taskName: string;
    taskNamePlaceholder: string;
    taskPrompt: string;
    taskPromptPlaceholder: string;
    frequency: string;
    frequencyHourly: string;
    frequencyDaily: string;
    frequencyWeekly: string;
    frequencyWeekdays: string;
    frequencyManual: string;
    executionTime: string;
    minuteOfHour: string;
    dayOfWeek: string;
    sunday: string;
    monday: string;
    tuesday: string;
    wednesday: string;
    thursday: string;
    friday: string;
    saturday: string;
    bindSkill: string;
    bindSkillNone: string;
    workspacePath: string;
    workspacePathPlaceholder: string;
    statusActive: string;
    statusPaused: string;
    runNow: string;
    pause: string;
    resume: string;
    edit: string;
    delete: string;
    deleteConfirm: string;
    lastRun: string;
    nextRun: string;
    never: string;
    noTasks: string;
    noTasksHint: string;
    noTasksCTA: string;
    runHistory: string;
    noRuns: string;
    runStatusRunning: string;
    runStatusCompleted: string;
    runStatusError: string;
    viewConversation: string;
    ago: string;
    running: string;
    activeCount: string;
    skippedDangerousOp: string;
    // v2 additions
    description: string;
    descriptionPlaceholder: string;
    backToList: string;
    taskDetail: string;
    prompt: string;
    schedule: string;
    status: string;
    totalRuns: string;
    taskCompleted: string;
    taskError: string;
    onlyRunWhileAwake: string;
    askAbuToCreate: string;
    askAbuCreatePrompt: string;
  };

  // Triggers
  trigger: {
    title: string;
    newTrigger: string;
    editTrigger: string;
    infoBanner: string;
    triggerName: string;
    triggerNamePlaceholder: string;
    description: string;
    descriptionPlaceholder: string;
    triggerPrompt: string;
    triggerPromptPlaceholder: string;
    promptHint: string;
    filterType: string;
    filterAlways: string;
    filterKeyword: string;
    filterRegex: string;
    keywords: string;
    keywordsPlaceholder: string;
    regexPattern: string;
    regexPlaceholder: string;
    filterField: string;
    filterFieldPlaceholder: string;
    filter: string;
    debounceEnabled: string;
    debounce: string;
    seconds: string;
    bindSkill: string;
    bindSkillNone: string;
    workspacePath: string;
    workspacePathPlaceholder: string;
    status: string;
    statusActive: string;
    statusPaused: string;
    pause: string;
    resume: string;
    edit: string;
    delete: string;
    deleteConfirm: string;
    totalRuns: string;
    httpEndpoint: string;
    copyEndpoint: string;
    curlExample: string;
    prompt: string;
    runHistory: string;
    noRuns: string;
    runStatusRunning: string;
    runStatusCompleted: string;
    runStatusError: string;
    runStatusFiltered: string;
    runStatusDebounced: string;
    viewConversation: string;
    lastTriggered: string;
    noTriggers: string;
    noTriggersHint: string;
    noTriggersCTA: string;
    askAbuToCreate: string;
    askAbuCreatePrompt: string;
    // Statistics
    statsSuccessRate: string;
    statsAvgNotAvailable: string;
    statsCompleted: string;
    statsErrors: string;
    statsFiltered: string;
    // Templates
    useTemplate: string;
    templateAlertSOP: string;
    templateAlertSOPDesc: string;
    templateAlertSOPPrompt: string;
    templateAlertSOPKeywords: string;
    templateLogWatch: string;
    templateLogWatchDesc: string;
    templateLogWatchPrompt: string;
    templatePeriodicCheck: string;
    templatePeriodicCheckDesc: string;
    templatePeriodicCheckPrompt: string;
    // Toast messages
    triggerCompleted: string;
    triggerError: string;
    // Source types
    sourceType: string;
    sourceHttp: string;
    sourceFile: string;
    sourceCron: string;
    // File source
    filePath: string;
    filePathPlaceholder: string;
    fileEvents: string;
    fileEventCreate: string;
    fileEventModify: string;
    fileEventDelete: string;
    filePattern: string;
    filePatternPlaceholder: string;
    // Cron source
    cronInterval: string;
    cronIntervalPlaceholder: string;
    // Quiet hours
    quietHours: string;
    quietHoursEnabled: string;
    quietHoursStart: string;
    quietHoursEnd: string;
    quietHoursHint: string;
    // Time formatting
    timeJustNow: string;
    timeMinutes: string;
    timeHours: string;
    timeDays: string;
    // Detail page units
    debounceSeconds: string;
    debounceOff: string;
    totalRunsCount: string;
    cronIntervalSeconds: string;
    duplicateName: string;
    testTrigger: string;
    testTriggerSent: string;
    conversationDeleted: string;
    // Output config
    outputConfig: string;
    enableOutput: string;
    outputPlatform: string;
    webhookUrl: string;
    webhookUrlPlaceholder: string;
    customHeaders: string;
    customHeadersPlaceholder: string;
    testPush: string;
    testPushSuccess: string;
    testPushFailed: string;
    extractMode: string;
    extractLastMessage: string;
    extractFull: string;
    extractTemplate: string;
    templatePlaceholder: string;
    templateVariables: string;
    outputSent: string;
    outputFailed: string;
    outputRetry: string;
    // Phase 1B: IM source
    imSource: string;
    imPlatform: string;
    imAppId: string;
    imAppIdPlaceholder: string;
    imAppSecret: string;
    imAppSecretPlaceholder: string;
    imListenScope: string;
    imScopeAll: string;
    imScopeMentionOnly: string;
    imScopeDirectOnly: string;
    imWebhookUrl: string;
    imWebhookUrlHint: string;
    outputTargetWebhook: string;
    outputTargetReplySource: string;
  };

  // IM Channel Settings
  imChannel: {
    title: string;
    description: string;
    addChannel: string;
    editChannel: string;
    channelName: string;
    channelNamePlaceholder: string;
    platform: string;
    appId: string;
    appIdPlaceholder: string;
    appSecret: string;
    appSecretPlaceholder: string;
    capability: string;
    capabilityChatOnly: string;
    capabilityReadTools: string;
    capabilitySafeTools: string;
    capabilityFull: string;
    responseMode: string;
    responseMentionOnly: string;
    responseMentionOnlyHint: string;
    responseAllMessages: string;
    responseAllMessagesHint: string;
    allowedUsers: string;
    allowedUsersPlaceholder: string;
    allowedUsersHint: string;
    workspacePaths: string;
    workspacePathsPlaceholder: string;
    sessionTimeout: string;
    sessionTimeoutMinutes: string;
    maxRounds: string;
    webhookUrl: string;
    webhookUrlHint: string;
    statusConnected: string;
    statusDisconnected: string;
    statusError: string;
    enable: string;
    disable: string;
    deleteConfirm: string;
    noChannels: string;
    noChannelsHint: string;
    activeSessions: string;
    // IM conversation info bar (Phase 3C)
    infoBarCapability: string;
    infoBarStarted: string;
    infoBarRounds: string;
    infoBarEndSession: string;
    infoBarEndConfirm: string;
  };

  // Window Close Dialog
  windowClose: {
    title: string;
    message: string;
    quit: string;
    minimize: string;
    rememberChoice: string;
  };

  // Updates
  updates: {
    newVersionAvailable: string;
    currentVersion: string;
    latestVersion: string;
    checkForUpdates: string;
    checking: string;
    upToDate: string;
    downloadUpdate: string;
    releaseNotes: string;
    checkFailed: string;
  };

  // About
  about: {
    feedback: string;
    feedbackDesc: string;
    sponsor: string;
    sponsorDesc: string;
  };

  // Quick Start Guide
  guide: {
    title: string;
    step1Title: string;
    step1Desc: string;
    step2Title: string;
    step2Desc: string;
    step3Title: string;
    step3Desc: string;
    step4Title: string;
    step4Desc: string;
    dismiss: string;
  };

  // Command Confirmation Dialog
  commandConfirm: {
    title: string;
    titleDanger: string;
    titleBlock: string;
    description: string;
    descriptionDanger: string;
    descriptionBlock: string;
    cancel: string;
    confirm: string;
    blocked: string;
    userCancelled: string;
  };

  // Tool error messages (used in core/tools/registry.ts)
  toolErrors: {
    userDeniedAccess: string;
    pathAccessDenied: string;
    needsAuthorization: string;
  };

  // Project Rules
  projectRules: {
    title: string;
    userRules: string;
    projectMainRules: string;
    modularRules: string;
    rulesTruncated: string;
    rulesNotModifiable: string;
  };
}
