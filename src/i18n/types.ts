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
    retry: string;
  };

  // Error Boundary
  errorBoundary: {
    renderError: string;
    unknownError: string;
    appError: string;
    appErrorHint: string;
    refresh: string;
    messageError: string;
  };

  // Memory UI
  memory: {
    categoryPreference: string;
    categoryProject: string;
    categoryFact: string;
    categoryDecision: string;
    categoryAction: string;
    categoryConversationIndex: string;
    categoryFeedback: string;
    entryCount: string;
    sourceAutoFlush: string;
    sourceAgentExplicit: string;
    sourceUserManual: string;
    /** @deprecated v0.15+: replaced by `updatedAt` in the UI */
    recallCount: string;
    /** "更新于 {age}" */
    updatedAt: string;
    /** "陈旧" inline badge */
    staleBadge: string;
    /** Tooltip explaining what stale means */
    staleTooltip: string;
    /** Lock icon tooltip */
    privateTooltip: string;
    /** Edit dialog: private toggle label */
    privateLabel: string;
    /** Edit dialog: private toggle description */
    privateDesc: string;
    /** Description-leak hint shown when toggling private on a memory whose
     *  description appears to contain the value rather than just the topic */
    privateDescHintTitle: string;
    privateDescHintBody: string;
    privateDescCurrent: string;
    privateDescNewLabel: string;
    privateDescPlaceholder: string;
    privateDescSave: string;
    privateDescSkip: string;
    /** Onboarding audit dialog */
    auditTitle: string;
    auditIntro: string;
    auditMarkAll: string;
    auditCancel: string;
    auditEmpty: string;
    auditPatternIdCard: string;
    auditPatternBankCard: string;
    auditPatternMobile: string;
    auditPatternEmailPassword: string;
    auditPatternSalary: string;
    deleteTitle: string;
    legacyHint: string;
    emptyHint: string;
    globalMemories: string;
    bulkCleanup: string;
    bulkExit: string;
    bulkSelected: string;
    bulkSelectAutoFlushUnused: string;
    bulkSelectUnused: string;
    bulkSelectAll: string;
    bulkClearSelection: string;
    bulkDelete: string;
    bulkConfirmTitle: string;
    bulkConfirmMessage: string;
    // Fallback topic labels for deriveTopicDescription (PersonalMemorySection)
    topicUser: string;
    topicFeedback: string;
    topicProject: string;
    topicReference: string;
    // Relative time labels for formatAge (MemoryViewModal)
    minutesAgo: string;
    hoursAgo: string;
    daysAgo: string;
    monthsAgo: string;
  };

  // Soul (personality)
  soul: {
    title: string;
    subtitle: string;
    placeholder: string;
    saving: string;
    saved: string;
    restore: string;
    restoreConfirmTitle: string;
    restoreConfirmMessage: string;
    filePath: string;
    // Proactivity preset (Task #23)
    proactivityTitle: string;
    proactivityDesc: string;
  };

  // Sidebar
  sidebar: {
    newTask: string;
    automation: string;
    scheduledTasks: string;
    triggers: string;
    toolbox: string;
    recents: string;
    searchPlaceholder: string;
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
    personalMemory: string;
    personalMemoryTitle: string;
    personalMemoryDesc: string;
    personalMemoryPlaceholder: string;
    personalMemoryClearMessage: string;
    memoryGuideTitle: string;
    memoryGuidePersonalName: string;
    memoryGuidePersonalDesc: string;
    memoryGuideProjectMemoryName: string;
    memoryGuideProjectMemoryDesc: string;
    memoryGuideProjectRulesName: string;
    memoryGuideProjectRulesDesc: string;
    memoryGuideTip: string;
    todos: string;
    inbox: string;
  };

  // Todos
  todos: {
    title: string;
    newTodo: string;
    placeholder: string;
    notesPlaceholder: string;
    tabAll: string;
    tabToday: string;
    empty: string;
    addedToTodos: string;
    priorityHigh: string;
    priorityMedium: string;
    priorityLow: string;
    assigneeHuman: string;
    assigneeAgent: string;
    quickAddFromConversation: string;
    addToTodos: string;
    dueToday: string;
    dueTomorrow: string;
    sourceConversation: string;
    sourceAgent: string;
  };

  // Inbox tabs and status badges
  inboxTabs: {
    pending: string;
    all: string;
    statusAccepted: string;
    statusIgnored: string;
  };

  // Inbox
  inbox: {
    title: string;
    empty: string;
    pendingCount: string;
    agentProposed: string;
    agentConfirmation: string;
    agentResult: string;
    agentError: string;
    accept: string;
    ignore: string;
    viewResult: string;
    markDone: string;
    requestRedo: string;
    cancelTask: string;
    retry: string;
    close: string;
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
    openWithDefaultApp: string;
    openFailed: string;
    clickToPreview: string;
    clickToPreviewImage: string;
    clickToPreviewFull: string;
    openWith: string;
    openWithPreview: string;
    openWithBrowser: string;
    fileMissing: string;
    fileOversized: string;
    fileBackupFailed: string;
    cannotRevealOriginal: string;
    sources: string;
    showAllSources: string;
    collapseSources: string;
    userMessageShowMore: string;
    userMessageCollapse: string;
    noModelConfigured: string;
    scrollToBottom: string;
    compressingContext: string;
    retrying: string;
    resuming: string;
    codeBlockExpand: string;
    codeBlockCollapse: string;
    codeBlockSaveAs: string;
    mermaidLoading: string;
    mermaidRenderError: string;
    mermaidExpand: string;
    mermaidCollapse: string;
    htmlWidgetLabel: string;
    htmlWidgetLoading: string;
    htmlWidgetRenderError: string;
    /** P3 — one-line muted row shown beneath a widget after it reports a
     *  runtime error (window.onerror / unhandledrejection), so a widget
     *  that broke mid-script doesn't just look mysteriously blank. */
    htmlWidgetErrorRow: string;
    htmlWidgetExpand: string;
    htmlWidgetCollapse: string;
    htmlWidgetFullscreen: string;
    htmlWidgetCopyCode: string;
    htmlWidgetCopied: string;
    htmlWidgetDownload: string;
    htmlWidgetViewCode: string;
    htmlWidgetViewPreview: string;
    // show_widget inline card status rows (invalid input / cancelled call)
    widgetCardError: string;
    widgetCardCancelled: string;
    // Enterprise model selector
    enterpriseModelLoading: string;
    enterpriseModelNoMatch: string;
    enterpriseModelEmpty: string;
    enterpriseGatewayLabel: string;
    // DetailBlockView
    characters: string;
    viewMore: string;
    moreItems: string;
    moreRows: string;
    setupRequired: string;
    setupRequiredDesc: string;
    setupButton: string;
    // MessageBubble
    thinkingProcess: string;
    copy: string;
    edit: string;
    regenerate: string;
    feedbackPositive: string;
    feedbackNegative: string;
    saveAndResend: string;
    clickToViewFull: string;
    imageExpired: string;
    inputTokens: string;
    outputTokens: string;
    addAttachment: string;
    // Agent selector in toolbar
    pickAgent: string;
    pickAgentEmpty: string;
    pickAgentClear: string;
    // Conversation ID badge
    copyConvIdTooltip: string;
    copyConvIdCopied: string;
    // Message time / day separator
    timeJustNow: string;
    timeMinutesAgo: string;
    dayYesterday: string;
    // Source navigation bar (for scheduled/trigger conversations)
    fromScheduledTask: string;
    fromTrigger: string;
    // Scenario guide
    trySaying: string;
    scenarios: Record<string, string>;
    scenarioPlaceholders: Record<string, string>;
    scenarioPrompts: Record<string, string>;
    /** Full prompt sent on click (falls back to scenarioPrompts if absent) */
    scenarioFullPrompts: Record<string, string>;
    // Context indicator (ring + tooltip)
    contextTooltipIdle: string;
    contextTooltipCompressing: string;
    contextTooltipUsage: string;
    contextTooltipSubtitle: string;
    // Agent loop max turns
    maxTurnsReached: string;
    // Agent loop no-progress guard (model stuck emitting unparseable tool calls)
    noProgressStopped: string;
    // Agent loop runtime status / errors + subagent result strings (P4-C)
    /** Error: no API key configured (keep the literal "API Key" substring). */
    configureApiKey: string;
    /** Skill requires tools that aren't currently available. {missing} */
    skillMissingTools: string;
    /** Enterprise AI gateway unreachable (shown as an error bubble). */
    gatewayUnreachable: string;
    /** Model likely doesn't support image/vision input. */
    visionUnsupported: string;
    /** Ollama returned 403 Forbidden (CORS origin restriction). */
    ollamaForbidden: string;
    /** Streamed-inline notice while compacting an oversized context (includes markdown). */
    compactingInlineNotice: string;
    /** Conversation-title fallback used in task notifications. */
    notificationTaskFallback: string;
    /** Error after repeated output-token-limit hits (multi-line). {limit} */
    outputLimitError: string;
    /** Tool-update notice header (injected into the conversation as a message). */
    toolsUpdatedHeader: string;
    /** Tool-update notice: added tools. {tools} */
    toolsAdded: string;
    /** Tool-update notice: removed tools. {tools} */
    toolsRemoved: string;
    /** Tool-update notice footer. */
    toolsUpdatedFooter: string;
    /** Subagent (subagentLoop.ts) result/status strings. */
    subagent: {
      /** Subagent task was cancelled. */
      taskCancelled: string;
      /** Output repeatedly hit the token limit; result may be incomplete. */
      outputLimitIncomplete: string;
      /** Subagent stopped: repeated incomplete tool calls / truncated output. */
      stoppedIncomplete: string;
      /** A tool call was cancelled. */
      cancelled: string;
      /** A tool call was blocked by a hook. */
      hookBlocked: string;
      /** Subagent produced no content. */
      noContent: string;
    };
    // Work-process fold label (Codex-style turn collapse). {duration} = e.g. "1m 4s"
    workedFor: string;
    stoppedAfter: string;
    // Usage chip
    usageChipInput: string;
    usageChipOutput: string;
    usageChipCache: string;
    usageChipRequests: string;
    usageChipSubtitle: string;
    /** Fallback when the API failed with an empty/opaque body (no error details). */
    errorEmptyBody: string;
    /** Hint appended to not_found errors: check endpoint URL / model capabilities. */
    errorNotFoundHint: string;
  };

  // Share (conversation export / import)
  share: {
    exportDialogTitle: string;
    loading: string;
    visibleToOthers: string;
    hiddenFromOthers: string;
    itemMessages: string;
    itemToolCalls: string;
    itemAiGenerated: string;
    itemUserFiles: string;
    itemCredentials: string;
    redactionTitle: string;
    redactionCount: string;
    noRedaction: string;
    previewTitle: string;
    previewEmpty: string;
    statsMessages: string;
    statsAttachments: string;
    statsSize: string;
    cancel: string;
    exportBtn: string;
    exportError: string;
    tierStandard: string;
    tierNote: string;
    // Sidebar badge shown on imported conversations
    importedBadge: string;
    importedBadgeWithDate: string;
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
    /** Shown in tool-call detail when the task was aborted mid-execution */
    cancelled: string;
  };

  // Notice menubar summaries (noticeMenubarStore.ts)
  noticeMenubar: {
    meetingPrep: string;
    permissionRequest: string;
    userInputNeeded: string;
    agentError: string;
    scheduleFired: string;
    taskComplete: string;
    skillProposalOffer: string;
    skillDraftReady: string;
    skillPatch: string;
    stuckDetection: string;
    imInbound: string;
    contextResume: string;
    deepFocusEnter: string;
    deepFocusExit: string;
  };

  // OS / in-app notification titles (channels.ts)
  noticeTitle: {
    taskComplete: string;
    agentError: string;
    scheduleFired: string;
    permissionRequest: string;
    userInputNeeded: string;
    meetingPrep: string;
    skillProposalOffer: string;
    skillDraftReady: string;
    imInbound: string;
    updateAvailable: string;
  };

  // Scratchpad entry titles (scratchpadStore.ts)
  scratchpad: {
    /** "Content extraction" (no file) */
    extractionTitle: string;
    /** "{file} - Content extraction" — use format() with {file} */
    extractionTitleFile: string;
    /** "Analysis" (no file) */
    analysisTitle: string;
    /** "{file} - Analysis" */
    analysisTitleFile: string;
    /** "Search: {query}" — use format() with {query} */
    searchTitle: string;
    /** "Search results" (no query) */
    searchResultsTitle: string;
    /** "Summary" (no file) */
    summaryTitle: string;
    /** "{file} - Summary" */
    summaryTitleFile: string;
    /** "Preview" (no file) */
    previewTitle: string;
    /** "{file} - Preview" */
    previewTitleFile: string;
    /** "Result" (fallback) */
    resultTitle: string;
  };

  // Chat/conversation defaults (chatStore.ts, fileWatcher.ts)
  chatDefaults: {
    /** Default title for a new conversation shown in the sidebar */
    newConversationTitle: string;
    /** File-watcher conversation title: "[Watching] {file} - {time}" */
    watcherConversationTitle: string;
  };

  // Batch Progress (run_agent_batch live UI)
  batch: {
    /** "并行执行 {n} 个子任务" */
    runningTitle: string;
    /** "停止" */
    stopButton: string;
    /** "第{n}轮" */
    turnLabel: string;
    /** "✓ {n} 个子任务完成" — completion summary */
    completionSummary: string;
    /** "展开" */
    expand: string;
    /** "收起" */
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
    anthropicCompatible: string;
    openaiCompatibleDesc: string;
    anthropicCompatibleDesc: string;
    apiUrl: string;
    apiUrlHint: string;
    apiUrlDesc: string;
    apiKey: string;
    apiKeyPlaceholder: string;
    apiKeyDesc: string;
    apiKeyDecryptFailed: string;
    clearAllKeys: string;
    clearAllKeysConfirm: string;
    clearAllKeysDone: string;
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
    billingPaygo: string;
    billingCoding: string;
    billingTokenPlan: string;
    billingAgent: string;
    configPlan: string;
    viewDocs: string;
    selectModel: string;
    customModel: string;
    // Custom services
    builtinProviders: string;
    myCustomServices: string;
    otherProviders: string;
    saveCurrentConfig: string;
    updateConfig: string;
    deleteConfig: string;
    saveServiceName: string;
    saveServicePlaceholder: string;
    saveServiceConfirm: string;
    saveServiceCancel: string;
    deleteServiceConfirm: string;
    serviceNameRequired: string;
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
    // Labs (experimental features)
    labs: string;
    labsDescription: string;
    labsEmpty: string;
    labsEmptyHint: string;
    labsExpTodosInboxTitle: string;
    labsExpTodosInboxDesc: string;
    labsExpTodosInboxWhere: string;
    labsExpPetWhere: string;
    labsExpPetDesc: string;
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
    preventSleep: string;
    preventSleepDesc: string;
    petEnable: string;
    petEnableDesc: string;
    appearance: string;
    appearanceLight: string;
    appearanceDark: string;
    appearanceSystem: string;
    // Permission mode
    permissionMode: string;
    permissionModeDesc: string;
    // Content Guard kill switch (Task #26)
    contentGuardTitle: string;
    contentGuardDesc: string;
    contentGuardDisableTitle: string;
    contentGuardDisableMessage: string;
    permissionModeStandard: string;
    permissionModeStandardDesc: string;
    permissionModeSmart: string;
    permissionModeSmartDesc: string;
    permissionModeAutonomous: string;
    permissionModeAutonomousDesc: string;
    // ModelConfigSection
    currentConfig: string;
    configured: string;
    notConfigured: string;
    selectProvider: string;
    selectPlaceholder: string;
    autoSaved: string;
    // Ollama
    localModelsGroup: string;
    ollamaStatus: string;
    ollamaOnline: string;
    ollamaOffline: string;
    ollamaChecking: string;
    ollamaRefreshModels: string;
    ollamaNoModels: string;
    ollamaNoModelsHint: string;
    ollamaUrlLabel: string;
    ollamaUrlHint: string;
    ollamaModelSize: string;
    // LM Studio
    lmstudioUrlLabel: string;
    lmstudioUrlHint: string;
    lmstudioOnline: string;
    lmstudioOffline: string;

    // Provider Management V2
    add: string;
    addService: string;
    editService: string;
    deleteService: string;
    serviceName: string;
    serviceNameAuto: string;
    selectProviderType: string;
    searchProvider: string;
    selectProviderFirst: string;
    localNoKeyNeeded: string;
    singleAccess: string;
    configMethodLocalPlaceholder: string;
    cloudProviders: string;
    localProviders: string;
    customProviders: string;
    /** Localized display names for select builtin providers whose
     *  PROVIDER_CONFIGS[id].name is not already brand/English (e.g. 火山引擎).
     *  Partial — only providers needing localization have an entry; callers
     *  fall back to PROVIDER_CONFIGS[id].name otherwise. */
    providerNames: Partial<Record<string, string>>;
    guide: string;
    guideGoTo: string;
    apiKeyRequired: string;
    apiKeyOptional: string;
    apiUrlPreview: string;
    fetchModels: string;
    fetchingModels: string;
    fetchModelsError: string;
    fetchModelsSuccess: string;
    addModelManually: string;
    addModel: string;
    addModelPlaceholder: string;
    useOtherModel: string;
    useOtherModelDesc: string;
    save: string;
    saveAnyway: string;
    goBackEdit: string;
    validating: string;
    validationSuccess: string;
    validationFailed: string;
    revalidate: string;
    validateConnection: string;
    statusConnected: string;
    statusFailed: string;
    statusUnchecked: string;
    enabledCount: string;
    editProvider: string;
    deleteProvider: string;
    deleteProviderConfirm: string;
    noProviders: string;
    noProvidersHint: string;
    noProvidersAction: string;
    auxiliary: string;
    auxiliarySearch: string;
    auxiliaryImageGen: string;
    builtinVia: string;
    providerEnabled: string;
    providerDisabled: string;
    cancelEdit: string;
    saveChanges: string;
    customApi: string;
    customApiOpenai: string;
    customApiAnthropic: string;
    models: string;
    modelsCount: string;
    capabilitiesLabel: string;
    // Advanced config (custom/local providers)
    advancedConfig: string;
    capTools: string;
    capImages: string;
    capReasoning: string;
    capRawUrl: string;
    capRawUrlHint: string;
    capEffort: string;
    effortLow: string;
    effortMedium: string;
    effortHigh: string;
    capMaxInput: string;
    capMaxOutput: string;
    capTokenDefault: string;
    capPerModelHint: string;
    // Model fetch status messages (ProviderCard + AddProviderModal)
    fetchModelsEmpty: string;
    fetchModelsFailed: string;
    // Scoped search over a large fetched-models checklist (aggregator/gateway convergence)
    filterModelsPlaceholder: string;
    filterModelsNoResults: string;
    // Enterprise tab label in SystemSettingsModal
    enterpriseMode: string;
  };

  // Sandbox recovery
  sandbox: {
    writeBlocked: string;
    writeBlockedDir: string;
    writeBlockedGeneric: string;
    authorizePath: string;
    pathAuthorized: string;
    retryHint: string;
    goToSettings: string;
    authorizedPaths: string;
    authorizedPathsEmpty: string;
    revoke: string;
  };

  // Diagnostic
  diagnostic: {
    title: string;
    desc: string;
    // Banner
    bannerAllPassed: string;
    bannerHasWarnings: string; // {n}
    bannerHasFailures: string; // {n}
    bannerChecking: string;
    bannerNoData: string;
    lastChecked: string; // {when}
    runAll: string;
    runAllAgain: string;
    firstRunCta: string;
    // Categories
    categoryAiServices: string;
    categoryPermissions: string;
    categoryMcp: string;
    categorySkills: string;
    categoryNetwork: string;
    categoryApp: string;
    categorySummaryAllPassed: string; // {n}
    categorySummaryMixed: string;     // {pass}, {warn}, {fail}
    categorySummaryEmpty: string;
    categoryRecheck: string;
    // Item statuses
    statusPassed: string;
    statusFailed: string;
    statusWarning: string;
    statusSkipped: string;
    statusChecking: string;
    // Item actions
    actionRecheck: string;
    actionCopyError: string;
    actionOpenAIServices: string;
    actionOpenAbout: string;
    actionOpenToolbox: string;
    copiedError: string;
    // AI services check
    aiServicesNoProvider: string;
    aiServicesNoProviderHint: string;
    aiServicesNoKey: string;
    /** Probe passed but a recent real call failed — {detail} = error code. */
    aiRecentFailure: string;
    // Permissions check
    permAppData: string;
    permWorkspace: string;
    permWorkspaceAbu: string;
    permWorkspaceNoSelection: string;
    // MCP
    mcpNone: string;
    mcpNoneHint: string;
    mcpToolCount: string; // {n}
    // Skills
    skillsLoader: string;
    skillsCount: string; // {total}, {builtin}, {user}
    skillsZero: string;
    skillsLoadFailed: string;
    // Network
    networkReachability: string;
    // App
    appVersion: string;
    appLatest: string;
    appUpdateAvailable: string; // {version}
    // Internal
    checkInternalError: string;
    // Detail toggle on failed items
    detailShow: string;
    detailHide: string;
    // Error map — friendly messages + action labels
    errMap: {
      // AI service codes
      aiAuth: string;
      aiRateLimit: string;
      aiOverloaded: string;
      aiServerError: string;
      aiNetworkError: string;
      aiNetworkBlocked: string;
      aiContextTooLong: string;
      aiInvalidRequest: string;
      aiModelUnsupported: string;
      aiBudgetExceeded: string;
      aiTimeout: string;
      aiOllamaForbidden: string;
      // Permissions
      permTauriScope: string;
      permOSDenied: string;
      permDiskFull: string;
      // Network
      netTimeout: string;
      netUnreachable: string;
      netGeneric: string;
      // Action labels
      actionFixApiKey: string;
      actionSwitchModel: string;
      actionOpenAIServices: string;
      actionRetry: string;
      // Fallback
      unknown: string;
    };
    // Export
    exportTitle: string;
    exportDesc: string;
    exportButton: string;
    exportInProgress: string;
    exportFailed: string;
    exportIncluded: string;
    exportPrivacy: string;
    exportIncludeRaw: string;
    exportIncludeAll: string;
    exportIncludeRawWarning: string;
    exportIncludedListTitle: string;
    exportPrivacyText: string;
    // Upload to console
    uploadButton: string;
    uploadInProgress: string;
    uploadSuccess: string;
    uploadFailed: string;
    uploadDescriptionPlaceholder: string;
    // Success card
    successTitle: string;
    successMeta: string; // {size}, {count}, {scrubbed}
    successOpenFinder: string;
    successCopyPath: string;
    successManifest: string;
    successDismiss: string;
    pathCopied: string;
    // Manifest modal
    manifestTitle: string;
    manifestClose: string;
    // Feedback navigation prompt at bottom of DiagnosticSection
    feedbackPageHint: string;
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
    // npm registry install
    installFromNpm: string;
    npmPackageName: string;
    npmPackagePlaceholder: string;
    npmRegistry: string;
    npmRegistryPlaceholder: string;
    npmRegistryHint: string;
    npmStepFetchingMetadata: string;
    npmStepDownloading: string;
    npmStepExtracting: string;
    npmStepInstalling: string;
    npmInstallSuccess: string;
    npmInstallFailed: string;
    npmNoSkillMd: string;
    npmPackageNotFound: string;
    npmAlreadyExists: string;
    npmOverwrite: string;
    npmFindAndInstall: string;
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
    uploadSuccessDetail: string;
    uploadFailed: string;
    uploadFileCount: string;
    exportSkill: string;
    exportSuccess: string;
    exportFailed: string;
    // Import .askill (Task #25 part B)
    importSkill: string;             // menu label
    importSuccess: string;           // toast title
    importFailed: string;            // toast title
    importConflictTitle: string;     // confirm dialog
    importConflictMessage: string;   // "{name} 已存在，是否覆盖？"
    importConflictOverwrite: string; // "覆盖"
    // Merged upload entry — folder / .askill / .zip via click or drag-drop
    importEntry: string;             // menu label + modal title
    dropZoneHint: string;            // drag-drop zone hint
    pickFolder: string;              // "选择文件夹"
    pickFile: string;                // "选择文件 (.askill/.zip)"
    importSkippedFiles: string;      // "跳过 {n} 个隐藏文件：{names}"
    manualAdd: string;
    // Skill detail & editor
    skillDetail: string;
    skillTrigger: string;
    skillTriggerPlaceholder: string;
    skillDoNotTrigger: string;
    skillDoNotTriggerPlaceholder: string;
    skillTags: string;
    skillAllowedTools: string;
    skillContext: string;
    skillContextInline: string;
    skillContextFork: string;
    skillMaxTurns: string;
    maxTurnsInheritGlobalHint: string;
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
    // Legacy category keys — retained for any straggler consumers, but
    // SkillsSection now drives its UX categorization through the
    // category* keys below (Task #25 taxonomy rework).
    mySkills: string;
    exampleSkills: string;
    globalSkills: string;
    projectSkills: string;
    projectSkillsBadge: string;
    // UX categories (Task #25 rework) — what users see in Toolbox.
    categoryMine: string;              // "我的"
    categoryAgentEvolved: string;      // "阿布沉淀"
    categoryAgentEvolvedBadge: string; // small badge e.g. "自进化"
    categoryAgentEvolvedEmpty: string; // placeholder when no drafts + no workspace-auto skills
    categoryBuiltin: string;           // "内置"
    skillSourceBuiltin: string;
    skillSourceUser: string;
    skillSourceStandard: string;
    skillSourceProject: string;
    skillSourceWorkspaceAuto: string;
    installAgentSkills: string;
    installAgentSkillsPlaceholder: string;
    installAgentSkillsHint: string;
    installAgentSkillsButton: string;
    recommendedSkills: string;
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
    // Agent detail panel display
    agentStartChat: string;
    agentIntro: string;
    agentExpertise: string;
    agentSamplePrompts: string;
    agentCategoryField: string;
    agentTagsField: string;
    // AgentEditor field placeholders
    agentIntroPlaceholder: string;
    agentExpertisePlaceholder: string;
    agentSamplePromptsPlaceholder: string;
    agentTagsPlaceholder: string;
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
    // Skill drafts panel (Module G)
    draftsTitle: string;
    draftsCount: string;               // e.g. "{count} 个草稿"
    draftsAcceptAll: string;
    draftsRejectAll: string;
    draftsAccept: string;
    draftsReject: string;
    draftsConfirmAcceptAll: string;    // e.g. "确认采纳全部 {count} 个草稿？"
    draftsConfirmRejectAll: string;
    draftsAcceptError: string;
    draftsRejectError: string;
    draftsTriggerReason: string;
    draftsCreatedAgo: string;          // "{when} 前"
    draftsExpiresIn: string;           // "{when} 后过期"
    draftsExpired: string;
    draftsEmpty: string;
    // Drafts onboarding (first draft ever)
    draftsOnboardTitle: string;
    draftsOnboardBody: string;
    draftsOnboardPickShy: string;
    draftsOnboardPickCompanion: string;
    draftsOnboardPickButler: string;
    draftsOnboardShyDesc: string;
    draftsOnboardCompanionDesc: string;
    draftsOnboardButlerDesc: string;
    draftsOnboardConfirm: string;
    // Interactive notice card · skill proposal (Module I)
    skillProposalCardTitle: string;
    skillProposalCardWhy: string;
    skillProposalCardExpand: string;
    skillProposalCardCollapse: string;
    skillProposalCardAccept: string;
    skillProposalCardReject: string;
    skillProposalCardRejectCategory: string;
    skillProposalCardAccepted: string;
    skillProposalCardRejected: string;
    skillProposalCardRejectedCategory: string;
    skillProposalCardDefer: string;      // "稍后处理" button (Task #43)
    skillProposalCardDeferred: string;   // settled-pill label for deferred state
    skillProposalCardMissing: string;   // draft file gone (accepted/expired elsewhere)
    skillProposalCardJump: string;      // "→ 打开技能面板" link label
    // First-use onboarding gate (Task #50)
    skillProposalCardOnboardGate: string;        // explanatory text
    skillProposalCardOnboardGateAction: string;  // button label
    // Interactive notice card · skill patched (Task #41)
    skillPatchedCardLabel: string;      // "Abu 修正了技能" / "Abu patched skill"
    // Grouped patch fold-row in MessageGroup
    skillPatchGroupLabel: string;       // "Abu 修改了技能" / "Abu modified skill"
    skillPatchGroupCount: string;       // "（{count} 处）" / "({count} locations)"
    // Interactive notice card · skill deleted (Task #17 v2)
    skillDeletedCardLabel: string;      // "Abu 删除了技能"
    skillDeletedCardRescuable: string;  // "可在 7 天内恢复"
    skillDeletedCardPermanent: string;  // "已永久删除"
    // Skill history modal (Task #24)
    historyMenuLabel: string;           // "查看历史" menu item
    historyModalTitle: string;          // "修改历史"
    historyEmpty: string;               // empty state explainer
    historyFileCount: string;           // "{count} 个文件"
    historyRevert: string;              // button label
    historyRevertSuccess: string;       // toast title
    historyRevertFailed: string;        // toast title (partial/full fail)
    historyRevertRestoredFiles: string; // "还原了 {count} 个文件"
    historyOpEdit: string;              // op badge
    historyOpPatch: string;
    historyOpWriteFile: string;
    historyOpRemoveFile: string;
    historyOpRevert: string;
    historyActionModified: string;      // file action badge
    historyActionCreated: string;
    historyActionRemoved: string;
    // Category blocks (Task #45 — reject-category undo)
    categoryBlocksTitle: string;        // "已屏蔽的同类提议"
    categoryBlocksCount: string;        // "{count} 条" interpolation
    categoryBlocksEmpty: string;        // (unused when hidden; kept for a11y)
    categoryBlocksUnblock: string;      // button label
    categoryBlocksUnblockError: string; // toast title on delete failure
    categoryBlocksHint: string;         // subtitle describing what these are
    // Enterprise-only tabs (shown when enterprise mode is active)
    enterpriseSkills: string;
    enterpriseMcp: string;
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
    // Compact inline permission labels (InlinePermissionRequest)
    compactAccessLabel: string;
    compactShellLabel: string;
    compactWriteLabel: string;
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
    instructions: string;
    instructionsAdd: string;
    instructionsTitle: string;
    instructionsDesc: string;
    instructionsPlaceholder: string;
    instructionsSaving: string;
    instructionsSaveFailed: string;
    memory: string;
    memoryEmpty: string;
    memoryTitle: string;
    memoryDesc: string;
    memoryPlaceholder: string;
    memoryClear: string;
    memoryClearTitle: string;
    memoryClearMessage: string;
    memoryClearConfirm: string;
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
    // Preview: PPTX fallback (lib renderer fails on some python-pptx output)
    pptxPreviewUnavailable: string;
    openWithPowerPoint: string;
    // Preview: data-URL image (no file path)
    imagePreview: string;
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
    startedAtLabel: string;
    completedAtLabel: string;
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
    // Output
    outputChannel: string;
    outputChannelNone: string;
    outputChannelHint: string;
    outputToGroup: string;
    outputToDM: string;
    outputChatIdPlaceholder: string;
    outputUserIdPlaceholder: string;
    outputPushFailed: string;
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
    outputPushSent: string;
    outputPushFailed: string;
    outputEnabled: string;
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
    // IM source
    imSource: string;
    imSelectChannel: string;
    imNoChannels: string;
    imListenScope: string;
    imScopeAll: string;
    imScopeMentionOnly: string;
    imScopeDirectOnly: string;
    imChatId: string;
    imChatIdPlaceholder: string;
    senderMatch: string;
    senderMatchPlaceholder: string;
    imWebhookUrl: string;
    imWebhookUrlHint: string;
    outputTargetWebhook: string;
    outputTargetIMChannel: string;
    outputSelectChannel: string;
    outputToGroup: string;
    outputToDM: string;
    outputChatIdPlaceholder: string;
    outputUserIdPlaceholder: string;
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
    infoBarGroup: string;
    infoBarEndSession: string;
    infoBarEndConfirm: string;
    sessionResetConfirm: string;
    sessionRecovered: string;
    sessionExpiredHint: string;
    sessionQueueFull: string;
    timeoutHint: string;
    groupConnection: string;
    groupBehavior: string;
    groupAccess: string;
    wechatBind: string;
    wechatBindHint: string;
    wechatScanQR: string;
    wechatWaiting: string;
    wechatExpireIn: string;
    wechatScanned: string;
    wechatSuccess: string;
    wechatExpired: string;
    wechatRetry: string;
    wechatRebind: string;
    wechatAccount: string;
    wechatSessionExpired: string;
  };

  // Window Close Dialog
  windowClose: {
    title: string;
    message: string;
    agentRunningWarning: string;
    quit: string;
    minimize: string;
    rememberChoice: string;
  };

  // Desktop pet window (standalone Tauri window)
  pet: {
    openMain: string;
    closePet: string;
    closeMenu: string;
    reply: string;
    replyPlaceholder: string;
    needAuth: string;
    expand: string;
    collapse: string;
    status: {
      idle: string;
      running: string;
      waiting: string;
      error: string;
      done: string;
    };
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
    justChecked: string;
    downloading: string;
    installing: string;
    restartToInstall: string;
    downloadFailed: string;
    retry: string;
    viewOnGitHub: string;
  };

  // About
  about: {
    feedback: string;
    wechatSectionTitle: string;
    feedbackDesc: string;
    sponsor: string;
    sponsorDesc: string;
    deviceId: string;
    deviceIdHint: string;
    copied: string;
    disclaimerLink: string;
    /** Suffix appended after the disclaimer link label, e.g. " (Full)". */
    disclaimerFullSuffix: string;
    licenseLinkLabel: string;
    disclaimerTitle: string;
    disclaimerClose: string;
  };

  // First-launch disclaimer banner
  disclaimerBanner: {
    line1: string;
    line2: string;
    line3: string;
    viewFull: string;
    dismiss: string;
  };

  // Quick Start Guide
  guide: {
    title: string;
    step1Title: string;
    step1Desc: string;
    step1Link: string;
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
    aiDenied: string;
  };

  // Tool error messages (used in core/tools/registry.ts)
  toolErrors: {
    userDeniedAccess: string;
    pathAccessDenied: string;
    needsAuthorization: string;
  };

  // Mid-task queued-message staging strip above the composer
  queueStrip: {
    /** Tooltip on a staged pill */
    queuedHint: string;
    /** aria-label / tooltip of the cancel button */
    cancel: string;
  };

  reference: {
    commentToChat: string;
    addToChat: string;
    commentPlaceholder: string;
    /** {max} 占位 */
    maxReached: string;
  };

  // report_plan — inline plan card in the chat flow
  planCard: {
    title: string;
    /** Shown while the plan approval dock is waiting for the user */
    awaiting: string;
    /** Unit for the collapsed step count, e.g. "3 步" */
    stepsUnit: string;
  };

  // ask_user_question — interactive choice card
  userQuestion: {
    cardTitle: string;
    singleSelectHint: string;
    multiSelectHint: string;
    otherOptionLabel: string;
    otherInputPlaceholder: string;
    submitButton: string;
    /** Confirm-mode submit label (plan approval two-step) */
    confirmButton: string;
    answeredLabel: string;
    submitDisabledHint: string;
    cancelledLabel: string;
    /** Pager counter, e.g. "1 / 3" — params: {current} {total} */
    pager: string;
    /** Waiting-for-answer status in the tool-call group */
    waitingForAnswer: string;
    /** Skip this question */
    skip: string;
    /** Marker appended to a skipped question's answer in the result */
    skippedMarker: string;
    /** Keyboard / interaction hint shown at the bottom of the dock */
    navHint: string;
    /** Label prefix for the question line in the settled bubble */
    qLabel: string;
    /** Label prefix for the answer line in the settled bubble */
    aLabel: string;
    /** aria-label: go to previous question */
    prevQuestion: string;
    /** aria-label: go to next question */
    nextQuestion: string;
    /** aria-label: dismiss / cancel the question */
    close: string;
    /** Header of the settled answers card (agent side) */
    yourChoiceLabel: string;
  };

  // Projects
  project: {
    sectionTitle: string;
    newTask: string;
    createProject: string;
    createTitle: string;
    createDesc: string;
    modeFromScratch: string;
    modeFromScratchDesc: string;
    modeFromConversation: string;
    modeFromConversationDesc: string;
    modeExistingFolder: string;
    modeExistingFolderDesc: string;
    nameLabel: string;
    namePlaceholder: string;
    iconLabel: string;
    descLabel: string;
    descPlaceholder: string;
    defaultsSection: string;
    defaultSkillsLabel: string;
    defaultSkillsPlaceholder: string;
    defaultMCPLabel: string;
    defaultMCPPlaceholder: string;
    /** Welcome-screen hint: "Promote {name} to a project?" */
    hintPromote: string;
    hintPromoteAction: string;
    hintPromoteDismiss: string;
    modelOverrideLabel: string;
    modelOverrideNone: string;
    detectedConfig: string;
    detectedMemory: string;
    folderConflict: string;
    suggestMigrate: string;
    settingsTitle: string;
    dangerZone: string;
    archiveProject: string;
    archiveConfirm: string;
    deleteProject: string;
    deleteConfirm: string;
    pin: string;
    unpin: string;
    editSettings: string;
    openInFinder: string;
    archive: string;
    restore: string;
    delete: string;
    archived: string;
    archivedCount: string;
    conversationCount: string;
    convertToProject: string;
    moveToProject: string;
    removeFromProject: string;
    /** "+N more" expander shown when a project has more than 5 conversations */
    showMore: string;
    /** Collapse the expanded conversation list back to the first few */
    showLess: string;
    emptyState: string;
    selectFolder: string;
    next: string;
    create: string;
    cancel: string;
    belongsToProject: string;
    projectLabel: string;
    projectNone: string;
    save: string;
  };

  // Usage Stats
  usage: {
    title: string;
    periodToday: string;
    periodWeek: string;
    periodMonth: string;
    periodAll: string;
    requests: string;
    inputTokens: string;
    outputTokens: string;
    cacheHitRate: string;
    bySkill: string;
    byModel: string;
    noData: string;
    heatmapTitle: string;
    dailyTitle: string;
    heatmapTooltipUsed: string;
    heatmapTooltipNoData: string;
    heatmapWeekdays: string[];
    heatmapLegendLess: string;
    heatmapLegendMore: string;
  };

  // Cloud Announcements
  announcement: {
    typeVersionUpdate: string;
    typeFeature: string;
    typeBreaking: string;
    typeGeneral: string;
    dismiss: string;
    ctaDefault: string;
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

  // Enterprise Login
  enterpriseLogin: {
    bindTitle: string;
    bindDescription: string;
    serverUrlLabel: string;
    serverUrlPlaceholder: string;
    continueButton: string;
    cancelButton: string;
    backButton: string;
    tabPassword: string;
    tabMagicLink: string;
    tabSso: string;
    emailLabel: string;
    emailPlaceholder: string;
    passwordLabel: string;
    passwordPlaceholder: string;
    signInButton: string;
    magicSendCodeButton: string;
    magicCodeLabel: string;
    magicCodePlaceholder: string;
    magicVerifyButton: string;
    magicSentHint: string;
    ssoCodeHint: string;
    ssoWaiting: string;
    errInvalidCredentials: string;
    errAccountPending: string;
    errAccountSuspended: string;
    errGeneric: string;
    /** Rate-limited; interpolates {seconds} when Retry-After is available. */
    errSlowDown: string;
    /** Rate-limited fallback when no Retry-After header is present. */
    errSlowDownGeneric: string;
    /** Magic-link code has expired. */
    errExpiredToken: string;
    /** The chosen login method is not enabled on this server. */
    errMethodNotEnabled: string;
    /** New registrations are closed. */
    errRegistrationClosed: string;
    /** Email domain not in the allowlist. */
    errDomainNotAllowed: string;
    /** Malformed request (developer-facing but shown as generic client error). */
    errInvalidRequest: string;
    processing: string;
  };

  // Enterprise runtime UI (gateway badge, policy confirm, status badge)
  enterprise: {
    usingGateway: string;
    gatewayDesc: string;
    organization: string;
    gateway: string;
    status: string;
    offline: string;
    /** Compact offline suffix shown in the status badge, e.g. "· Offline". */
    offlineBadge: string;
    policyConfirmTitle: string;
    allowOnce: string;
    // EnterpriseSection settings panel
    title: string;
    description: string;
    bindSectionTitle: string;
    bindSectionDesc: string;
    bindButton: string;
    boundStatus: string;
    instanceLabel: string;
    loginIdentityLabel: string;
    boundAtLabel: string;
    myDataTitle: string;
    collapseData: string;
    viewMyData: string;
    migrationTitle: string;
    migrateButton: string;
    migrateDescription: string;
    unbindConfirm: string;
    unbindButton: string;
  };

  // Computer-use runtime status bar + screen-border overlay windows
  computerUse: {
    controlling: string;
    /** Interpolates {step}, e.g. "· Step {step}". */
    step: string;
    stop: string;
    /** Overlay status-bar step label, interpolates {step}, e.g. "Step {step}". */
    overlayStep: string;
    /** Overlay stop-button label. */
    stopControl: string;
  };

  // Tool runtime result strings (execute() returns/success/error messages).
  // These are UI-facing: rendered in ToolCallsGroup and also fed back to the
  // LLM, so they go through i18n (resolved at execution time by the current
  // locale) rather than being hardcoded in either language. See CLAUDE.md §1.
  toolResult: {
    // Shared value fragments reused across tools.
    valueNone: string;
    valueNever: string;
    statusActive: string;
    statusPaused: string;
    /** Locale-appropriate separator for joining inline lists of items. */
    listSeparator: string;
    // report_plan / update_memory / todo_write / log_task_completion
    memory: {
      // reportPlanTool
      /** User approved the plan. */
      planApproved: string;
      /** Plan approval timed out or was cancelled. */
      planTimeout: string;
      /** User rejected the plan. */
      planRejected: string;
      /** Plan recorded (no steps). */
      planRecorded: string;
      /** Plan recorded with N steps. {count} */
      planRecordedSteps: string;
      /** Plan-approval card header. */
      planApprovalHeader: string;
      /** Plan-approval card question (rendered after step list). */
      planApprovalQuestion: string;
      /** Approve option label. */
      planApproveLabel: string;
      /** Reject option label. */
      planRejectLabel: string;
      // updateMemoryTool
      /** Memory cleared. {count} */
      memoryClearedCount: string;
      /** Error: delete requires filename. */
      errDeleteNeedsFilename: string;
      /** Memory deleted. {filename} */
      memoryDeleted: string;
      /** Error: edit requires filename. */
      errEditNeedsFilename: string;
      /** Error: edit requires content. */
      errEditNeedsContent: string;
      /** Error: filename not found. {filename} */
      errFilenameNotFound: string;
      /** Memory updated. {type}, {name}, {filename}, optional {lock} */
      memoryUpdated: string;
      /** Error: append content cannot be empty. */
      errAppendContentEmpty: string;
      /** Memory saved. {type}, {name}, {filename}, optional {lock} */
      memorySaved: string;
      // todoWriteTool
      /** Error: no active session. */
      errNoActiveSession: string;
      /** Error: items list required. */
      errItemsRequired: string;
      /** Created N todo items. {n} */
      todosCreated: string;
      /** Error: content required. */
      errContentRequired: string;
      /** Todo item added. {content}, {id} */
      todoAdded: string;
      /** Error: todo_id required. */
      errTodoIdRequired: string;
      /** Error: todo item not found. {id} */
      errTodoNotFound: string;
      /** Todo item updated. {content}, {status} */
      todoUpdated: string;
      /** No tasks in the current plan. */
      todosEmpty: string;
      /** Details section header (includes IDs). */
      todosDetailHeader: string;
      /** Error: unknown action. {action} */
      errUnknownAction: string;
      // logTaskCompletionTool
      /** Task logged. */
      taskLogged: string;
    };
    // manage_scheduled_task / manage_trigger / manage_file_watch
    automation: {
      // scheduled task
      errMissingTaskName: string;
      errMissingPrompt: string;
      errMissingFrequency: string;
      /** {name}, {id} */
      errDuplicateTask: string;
      errTimeHourRange: string;
      errTimeMinuteRange: string;
      errDayOfWeekRange: string;
      /** {name}, {id}, {frequency}, {nextRun} */
      taskCreated: string;
      listEmptyAll: string;
      /** {status} */
      listEmptyFiltered: string;
      /** {icon}, {name}, {id}, {frequency}, {nextRun}, {runs} */
      listItem: string;
      /** {count}, {lines} */
      listHeader: string;
      errMissingTaskId: string;
      /** {id} */
      errTaskNotFound: string;
      /** {name}, {id} */
      taskUpdated: string;
      /** {name}, {id} */
      taskDeleted: string;
      /** {name} */
      taskAlreadyPaused: string;
      /** {name}, {id} */
      taskPaused: string;
      /** {name} */
      taskAlreadyActive: string;
      /** {name}, {id}, {nextRun} */
      taskResumed: string;
      /** {action} */
      errUnknownAction: string;
      // trigger
      errMissingTriggerName: string;
      /** {name}, {id} */
      errDuplicateTrigger: string;
      errFileNeedsPath: string;
      errCronNeedsInterval: string;
      /** {name} */
      triggerCreatedHeader: string;
      /** {type} */
      triggerTypeLine: string;
      sourceFile: string;
      sourceCron: string;
      /** {path} */
      watchPathLine: string;
      /** {events} */
      watchEventsLine: string;
      /** {pattern} */
      fileFilterLine: string;
      /** {seconds} */
      pollIntervalLine: string;
      /** {endpoint} */
      httpEndpointLine: string;
      externalTriggerCmd: string;
      sampleMessage: string;
      capReadTools: string;
      capSafeTools: string;
      capFull: string;
      capCustom: string;
      /** {label} */
      capLevelLine: string;
      /** {filter} */
      filterLine: string;
      /** {value} */
      debounceLine: string;
      /** {seconds} */
      debounceSeconds: string;
      debounceOff: string;
      /** {list} */
      allowCommandsLine: string;
      /** {list} */
      allowPathsLine: string;
      /** {list} */
      allowToolsLine: string;
      triggerListEmptyAll: string;
      /** {status} */
      triggerListEmptyFiltered: string;
      /** {path} */
      triggerSourceFileLabel: string;
      /** {seconds} */
      triggerSourceCronLabel: string;
      /** {endpoint} */
      triggerSourceHttpLabel: string;
      /** {icon}, {name}, {id}, {source}, {filterType}, {lastRun}, {runs} */
      triggerListItem: string;
      /** {count}, {lines} */
      triggerListHeader: string;
      errMissingTriggerId: string;
      /** {id} */
      errTriggerNotFound: string;
      /** {name}, {id} */
      triggerUpdated: string;
      /** {name}, {id} */
      triggerDeleted: string;
      /** {name} */
      triggerAlreadyPaused: string;
      /** {name}, {id} */
      triggerPaused: string;
      /** {name} */
      triggerAlreadyActive: string;
      /** {name}, {id} */
      triggerResumed: string;
      // file watch
      fwListEmpty: string;
      fwStatusRunning: string;
      fwStatusEnabled: string;
      fwStatusDisabled: string;
      /** {status}, {id}, {path}, {pattern}, {event}, {prompt} */
      fwListItem: string;
      /** {count}, {lines} */
      fwListHeader: string;
      fwErrAddNeeds: string;
      /** {id}, {path} */
      fwRuleCreated: string;
      fwErrRemoveNeeds: string;
      /** {id} */
      fwRuleRemoved: string;
      fwErrToggleNeeds: string;
      /** {id} */
      fwRuleToggled: string;
      /** {action} */
      fwUnknownAction: string;
    };
    // use_skill / delegate_to_agent / save_agent / request_workspace
    agent: {
      // use_skill
      /** Skill already active in this conversation. {skillName} */
      skillAlreadyActive: string;
      /** Skill loaded. {name}, {description} */
      skillLoaded: string;
      /** Context line appended after skillLoaded. {context} */
      skillContextLine: string;
      /** Line appended after skillLoaded (and optional context). */
      skillInjected: string;
      // delegate_to_agent
      /** Error: agent not found. {agentName}, {available}, {presetList} */
      errAgentNotFound: string;
      /** Error: agent disabled. {agentName} */
      errAgentDisabled: string;
      /** Error: must specify agent_name or type. */
      errMustSpecifyAgent: string;
      // save_skill / save_agent (createSaveItemTool)
      /** Word for "skill" used in labels/messages. */
      labelSkill: string;
      /** Word for "agent" used in labels/messages. */
      labelAgent: string;
      /** Error: invalid name. {label}, {name} */
      errInvalidName: string;
      /** Error: unsafe file path. {p} */
      errUnsafeFilePath: string;
      /** Attached-files section header + list. {list} */
      savedFileList: string;
      /** Success: skill saved. {label}, {name}, {filePath}, {fileList} */
      skillSaved: string;
      /** Success: agent saved. {label}, {name}, {filePath}, {fileList} */
      agentSaved: string;
      // request_workspace
      /** Workspace selected by user. {result} */
      workspaceSelected: string;
      /** User cancelled workspace selection. */
      workspaceCancelled: string;
    };
    // run_agent_batch pure helpers (aggregateBatchResults / runWithConcurrency / runWithTimeout)
    orchestration: {
      /** Error: tasks must be a non-empty array. */
      errTasksRequired: string;
      /** Error: tasks supports at most 16 items. */
      errTasksTooMany: string;
      /** Error: task description at index i cannot be empty. {i} */
      errTaskEmpty: string;
      /** Error: agent not found in batch task. {i}, {agentName}, {available}, {presetList} */
      errBatchAgentNotFound: string;
      /** Error: agent disabled in batch task. {i}, {agentName} */
      errBatchAgentDisabled: string;
      /** Activity label when a sub-agent calls a tool. {toolName} */
      activityCalling: string;
      /** Timeout error message for runWithTimeout. */
      errTimeout: string;
      /** Cancellation error message for runWithConcurrency cancelled slots. */
      errCancelled: string;
      /** aggregateBatchResults header. {total}, {successCount}, {failCount} */
      batchHeader: string;
      /** aggregateBatchResults section title. {n}, {label} */
      batchSectionTitle: string;
      /** aggregateBatchResults failure prefix. {text} */
      batchFailPrefix: string;
      /** Structured path: could not parse JSON. */
      errJsonParseFailed: string;
      /** Structured path: missing required fields. {fields} */
      errMissingFields: string;
    };
    // recall / read_memory
    recall: {
      /** Restraint note appended to private memory content. */
      privateMemoryNote: string;
      /** Suffix on a private-memory recall line. */
      privateMemorySuffix: string;
      /** {count} */
      sectionMemories: string;
      /** {count} */
      sectionTasks: string;
      /** {title}, {count}, {time} */
      convLine: string;
      untitled: string;
      /** {count} */
      sectionConversations: string;
      /** {query} */
      noResultsQuery: string;
      noResultsEmpty: string;
      errFilenameEmpty: string;
      /** {filename} */
      notFound: string;
    };
    // test_skill_trigger / improve_skill_description (eval tools)
    skillEval: {
      errNoQueries: string;
      /** {passed}, {total}, {rate} */
      overviewLine: string;
      errInvalidJson: string;
      /** {description} */
      allPassed: string;
      /** {error} */
      errLlmFailed: string;
    };
    // skill_manage (install / create)
    skill: {
      errInstallNeedsSource: string;
      /** Suffix appended to an ALREADY_EXISTS installer message. */
      overwriteHint: string;
      /** {error} */
      installFailed: string;
      /** {count}, {files} */
      skippedNote: string;
      /** {name}, {count}, {skippedNote} */
      installed: string;
      /** {name}, {path} */
      draftProposed: string;
      /** {name}, {path} */
      skillCreated: string;
    };
    // manage_mcp_server
    system: {
      /** Error: action=search requires query. */
      errSearchNeedsQuery: string;
      /** No MCP server matched the query. {query} */
      searchNoResults: string;
      /** Env-var needed note fragment. {envList} */
      searchEnvNote: string;
      /** Search results header. {count}, {lines} */
      searchResults: string;
      /** Error: action=install requires name. */
      errInstallNeedsName: string;
      /** MCP server not found. {name} */
      errInstallNotFound: string;
      /** Install failed. {error} */
      installFailed: string;
      /** Error: action=ensure requires name. */
      errEnsureNeedsName: string;
      /** Ensure available failed. {error} */
      ensureFailed: string;
      /** Error: action=add_custom requires name. */
      errAddCustomNeedsName: string;
      /** Error: action=add_custom requires url. */
      errAddCustomNeedsUrl: string;
      /** Add custom MCP service failed. {error} */
      addCustomFailed: string;
      /** Unknown action. {action} */
      errUnknownAction: string;
      // --- mcpDiscovery.ts: built-in MCP catalog + install/connect result messages ---
      /** Built-in MCP catalog: server descriptions keyed by server name. */
      mcpCatalog: Record<string, string>;
      /** MCP env-var config hints keyed by env-var name. */
      mcpEnvHints: Record<string, string>;
      /** Generic unknown-error fallback for MCP connect failures. */
      mcpUnknownError: string;
      /** Server connected. {name}, {count} */
      mcpConnected: string;
      /** Server reconnected. {name}, {count} */
      mcpReconnected: string;
      /** Server connect failed. {name}, {error} */
      mcpConnectFailed: string;
      /** Install needs env vars. {name}, {hints} */
      mcpNeedsEnvVars: string;
      /** Installed and connected. {name}, {count} */
      mcpInstalledConnected: string;
      /** Installed but connect failed. {name}, {error} */
      mcpInstallConnectFailed: string;
      /** name and url are both required. */
      mcpNameUrlRequired: string;
      /** Invalid URL format. {url} */
      mcpInvalidUrl: string;
      /** Added-server tool-list fragment. {tools} */
      mcpAddedToolList: string;
      /** Added and connected. {name}, {count}, {toolList} */
      mcpAddedConnected: string;
      /** Added but connect failed. {name}, {error} */
      mcpAddConnectFailed: string;
      /** Not found in built-in registry. {name} */
      mcpNotInRegistry: string;
      /** Install needs config. {name}, {hints} */
      mcpNeedsConfig: string;
    };
    // projectRules.ts: rule-bundle headers/markers, ABU.md template, /init results
    projectRules: {
      /** User-rules truncation marker appended to the rules text (LLM reads it). */
      userRulesTruncated: string;
      /** Combined-rules truncation marker. */
      rulesTruncated: string;
      /** User-rules bundle header (### heading + source path). */
      userRulesHeader: string;
      /** Project-rules bundle header. */
      projectRulesHeader: string;
      /** Modular-rules bundle header. */
      modularRulesHeader: string;
      /** Full ABU.md starter template written by /init (user-editable file). */
      abuTemplate: string;
      /** ABU.md already exists. */
      abuAlreadyExists: string;
      /** Created ABU.md template. */
      abuTemplateCreated: string;
      /** Failed to create ABU.md. {error} */
      abuCreateFailed: string;
      /** Created rules directory. */
      rulesDirCreated: string;
      /** Failed to create rules directory. {error} */
      rulesDirCreateFailed: string;
    };
    // web_search / http_fetch
    web: {
      /** No API key configured (non-SearXNG). */
      errNoApiKey: string;
      /** No SearXNG URL configured. */
      errNoSearxngUrl: string;
      /** No search results found. {query} */
      noResults: string;
      /** Search results header. {count}, {lines} */
      searchResults: string;
      /** Search error. {error} */
      searchError: string;
    };
    // generate_image / process_image
    media: {
      /** API returned no image data. */
      errNoImageData: string;
      /** Image saved. {path} */
      imageSaved: string;
      /** Revised prompt suffix. {prompt} */
      revisedPrompt: string;
    };
    // create_todo
    todo: {
      /** Error: title cannot be empty. */
      errTitleEmpty: string;
      /** Todo proposal placed in inbox. {title} */
      proposalAdded: string;
    };
    // tool_search
    toolSearch: {
      /** No tool matched the query. {query} */
      noResults: string;
      /** Parameter schema label (used in result formatting). */
      schemaLabel: string;
      /** Results header and footer. {count}, {results} */
      resultsFound: string;
    };
    // ask_user_question — validation errors and result formatting
    askUserQuestion: {
      /** Error: questions array length must be 1–4. {received} */
      errQuestionsLength: string;
      /** Error: question {idx} header cannot be empty. */
      errHeaderEmpty: string;
      /** Error: question {idx} header "{header}" exceeds 12 chars (current: {len}). */
      errHeaderTooLong: string;
      /** Error: question {idx} question text cannot be empty. */
      errQuestionEmpty: string;
      /** Error: question {idx} multiSelect must be boolean. {received} */
      errMultiSelectType: string;
      /** Error: question {idx} options length must be 2–4. {received} */
      errOptionsLength: string;
      /** Error: question {idx} options[{j}].label cannot be empty. */
      errOptionLabelEmpty: string;
      /** Internal error: toolCallId not injected. */
      errNoToolCallId: string;
      /** User cancelled or timed out. */
      cancelled: string;
      /** Header line for the answers result. */
      answersHeader: string;
    };
    // update_soul
    updateSoul: {
      /** Error: content cannot be empty. */
      errContentEmpty: string;
      /** Soul updated successfully. */
      updated: string;
      /** Update failed. {error} */
      updateFailed: string;
    };
    // read_file / write_file / edit_file
    file: {
      /** Non-vision model image skip note. {path}, {mediaType} */
      imageSkipNoVision: string;
      /** File locked by another agent. {path} */
      errFileLocked: string;
    };
    // show_widget / read_me — inline visualization tool
    widget: {
      /** Error: title cannot be empty. */
      errTitleEmpty: string;
      /** Error: widget_code cannot be empty. */
      errWidgetCodeEmpty: string;
      /** Error: loading_messages must have 1-4 entries. {received} */
      errLoadingMessagesLength: string;
      /** Error: loading_messages[{idx}] must be a non-empty string. */
      errLoadingMessageEntry: string;
      /** Error: widget_code exceeds the ~1MB size budget. */
      errWidgetCodeTooLarge: string;
      /** Error: widget_code contains a document wrapper tag (doctype/html/head/body). */
      errFullDocument: string;
      /** Error: widget_code references localStorage/sessionStorage (unavailable in the sandbox). */
      errStorageApi: string;
      /** Error: widget_code uses position:fixed (breaks auto-sizing). */
      errPositionFixed: string;
      /** Error: widget_code contains a <form> element. */
      errFormElement: string;
      /** Success: widget rendered. {title} */
      rendered: string;
    };
    // commandSafety — injection reason strings and danger-level labels
    commandSafety: {
      // hasCommandInjection — Unix/cross-platform injection reasons
      injSemicolonRm: string;
      injPipeRm: string;
      injAmpRm: string;
      injOrRm: string;
      injSubstRm: string;
      injBacktickRm: string;
      injSemicolonSudo: string;
      injPipeSudo: string;
      injEvalArbitrary: string;
      injExecReplace: string;
      injDevTcpSource: string;
      injProcessSubstitution: string;
      injBashInteractive: string;
      injNcReverseShell: string;
      injPythonSocket: string;
      injPythonOsSystem: string;
      injPythonSubprocess: string;
      injPerlSystem: string;
      injRubySystem: string;
      injIfsBypass: string;
      injBraceExpand: string;
      injNestedVarSubst: string;
      injDevTcpRedirect: string;
      injBase64Pipe: string;
      injEchoPipeShell: string;
      injPrintfPipeShell: string;
      // hasCommandInjection — Windows-specific injection reasons
      injWinPipeDel: string;
      injWinPipeFormat: string;
      injWinAmpFormat: string;
      injWinSemicolonRemoveItem: string;
      injWinSemicolonRi: string;
      injWinSemicolonErase: string;
      injWinPsEncodedCmd: string;
      injWinPsEncodedCmdShort: string;
      injWinPsHidden: string;
      injWinPsNoProfile: string;
      injWinCmdDel: string;
      // getDangerLevelLabel — danger level display labels
      levelBlock: string;
      levelDanger: string;
      levelWarn: string;
      levelSafe: string;
      // DANGEROUS_PATTERNS — block tier
      blockRmRoot: string;
      blockRmHome: string;
      blockRmRootWild: string;
      blockRmHomeWild: string;
      blockSudoRmRoot: string;
      blockDdSda: string;
      blockDdNvme: string;
      blockDdDisk: string;
      blockMkfs: string;
      blockForkBomb: string;
      blockSilentBg: string;
      blockCatSshKey: string;
      blockCatAwsCreds: string;
      blockWriteSshKeys: string;
      blockWriteShellRc: string;
      // DANGEROUS_PATTERNS — danger tier
      dangerRmRf: string;
      dangerRmWild: string;
      dangerGitPushForce: string;
      dangerGitResetHard: string;
      dangerGitCleanF: string;
      dangerGitCheckoutDot: string;
      dangerChmod777: string;
      dangerChmodR777: string;
      dangerCurlPipeSh: string;
      dangerCurlPipePython: string;
      dangerPipBreakSystem: string;
      dangerNpmForce: string;
      dangerBashCRm: string;
      dangerShCRm: string;
      dangerXargsRm: string;
      dangerFindDelete: string;
      dangerFindExecRm: string;
      // DANGEROUS_PATTERNS — warn tier
      warnSudo: string;
      warnRm: string;
      warnGitPush: string;
      warnNpmPublish: string;
      warnBrewUninstall: string;
      warnPipUninstall: string;
      warnAptRemove: string;
      warnAptPurge: string;
      warnMvDevNull: string;
      warnTruncate: string;
      warnShred: string;
      warnKill9: string;
      warnKillall: string;
      warnPkill: string;
      warnSystemctlStop: string;
      warnLaunchctl: string;
      // WIN_DANGEROUS_PATTERNS — block tier
      winDelRecursiveDrive: string;
      winFormatDisk: string;
      winRegDeleteSystem: string;
      winOverwritePhysicalDisk: string;
      winDiskpart: string;
      winBcdedit: string;
      winCipherWipe: string;
      winBlockPsProfile: string;
      winRundll32: string;
      winRegsvcs: string;
      winRegasm: string;
      winInstallUtil: string;
      winMavinject: string;
      winMshtaVbscript: string;
      winMshtaJavascript: string;
      winFodhelper: string;
      winCertutilEncode: string;
      // WIN_DANGEROUS_PATTERNS — danger tier
      winDelRecursive: string;
      winRmdirRecursive: string;
      winPsRemoveItemRecurse: string;
      winPsRiRecurse: string;
      winRegDelete: string;
      winRegExport: string;
      winRegSave: string;
      winPsBypassPolicy: string;
      winInvokeWebExec: string;
      winInvokeExpression: string;
      winCertutilDecode: string;
      winCertutilUrlcache: string;
      winBitsadmin: string;
      winMshta: string;
      winWmicProcessCreate: string;
      winWmicOsDelete: string;
      winCscriptExec: string;
      winWscriptExec: string;
      winTakeownRecurse: string;
      winIcaclsGrantAll: string;
      winNetshWlanKey: string;
      winVssDeleteShadows: string;
      // WIN_DANGEROUS_PATTERNS — warn tier
      winDelFile: string;
      winRmdirDir: string;
      winPsRemoveItem: string;
      winPsRi: string;
      winPsErase: string;
      winPsClearContent: string;
      winPsClearRecycleBin: string;
      winRunas: string;
      winTaskkillForce: string;
      winNetStop: string;
      winScDelete: string;
      winSchtasksDelete: string;
      winTakeown: string;
      winIcacls: string;
      winRegAdd: string;
      winWmic: string;
      winNetshFirewall: string;
      winNetshAdvFirewall: string;
    };
    // computer (computerTools.ts) — AX/screenshot/input action results and errors
    computer: {
      /** formatAxElements: no interactive elements found. */
      noInteractiveElements: string;
      /** screenshot: current model has no vision capability (bilingual). zh half. */
      errNoVision: string;
      /** activate_app: missing app parameter. */
      errActivateNeedsApp: string;
      /** activate_app success. {name} */
      activateSuccess: string;
      /** activate_app failure. {msg} */
      errActivateFailed: string;
      /** get_app_state: AX tree truncated note. */
      axTreeTruncated: string;
      /** get_app_state: AX tree header. {app}, {count}, {visited}, {note}, {formatted} */
      axTreeHeader: string;
      /** get_app_state: AX tree fetch failed. {msg} */
      axTreeFailed: string;
      /** get_app_state: operation hint appended to AX tree (vision path). */
      axSuffixVision: string;
      /** get_app_state: screenshot section header (vision path). */
      axScreenshotSeparator: string;
      /** get_app_state: operation hint (non-vision path). */
      axSuffixNoVision: string;
      /** click: AXPress succeeded. {elemId} */
      clickAxSuccess: string;
      /** click: AXPress failed, fallback to element center. {msg}, {cx}, {cy} */
      clickAxFallbackCenter: string;
      /** click: AXPress failed, fallback to caller-supplied coords. {msg}, {x}, {y} */
      clickAxFallbackCoords: string;
      /** click: AXPress failed, no fallback coords available. {msg} */
      errClickAxNoFallback: string;
      /** click: element_id provided but no active AX session. */
      errClickNoSession: string;
      /** click: no element_id and no x,y coordinates. */
      errClickNeedsCoords: string;
      /** scroll: element in AX session, scrolled at element center. {dir}, {amt}, {elemId}, {cx}, {cy} */
      scrollAtElement: string;
      /** scroll: element_id not in current snapshot. {elemId} */
      errScrollElemNotFound: string;
      /** scroll: no element_id and no x,y coordinates. */
      errScrollNeedsCoords: string;
      /** type: AXSetValue succeeded. {elemId} */
      typeAxSuccess: string;
      /** type: AXSetValue failed, fallback to keyboard. {msg} */
      typeAxFallback: string;
      /** perform_action: missing action_name. */
      errPerformNeedsActionName: string;
      /** perform_action: no active AX session. */
      errPerformNoSession: string;
      /** perform_action: succeeded. {elemId}, {actionName} */
      performSuccess: string;
      /** perform_action: failed. {msg} */
      errPerformFailed: string;
      /** ax_click: no active AX session. */
      errAxClickNoSession: string;
      /** ax_click: AXPress succeeded. {elemId} */
      axClickSuccess: string;
      /** ax_click: AXPress failed, fallback to pixel click. {msg}, {x}, {y} */
      axClickFallback: string;
      /** ax_click: AXPress failed, no coords fallback. {msg} */
      errAxClickFailed: string;
      /** ax_type: no active AX session. */
      errAxTypeNoSession: string;
      /** ax_type: AXSetValue succeeded. {elemId} */
      axTypeSuccess: string;
      /** ax_type: AXSetValue failed, fallback to keyboard. {msg} */
      axTypeFallback: string;
      /** Screen recording permission denied (bilingual). zh half. */
      errNoScreenRecording: string;
      /** Windows: accessibility requires elevation (bilingual). zh half. */
      errWindowsNeedsAdmin: string;
      /** macOS: accessibility permission denied (bilingual). zh half. */
      errMacOSNeedsAccessibility: string;
    };
  };
}
