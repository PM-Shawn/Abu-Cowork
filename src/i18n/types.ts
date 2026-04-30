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
    recallCount: string;
    deleteTitle: string;
    legacyHint: string;
    emptyHint: string;
    globalMemories: string;
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
    fileMissing: string;
    fileOversized: string;
    fileBackupFailed: string;
    cannotRevealOriginal: string;
    sources: string;
    showAllSources: string;
    collapseSources: string;
    scrollToBottom: string;
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
    htmlWidgetExpand: string;
    htmlWidgetCollapse: string;
    htmlWidgetFullscreen: string;
    htmlWidgetCopyCode: string;
    htmlWidgetCopied: string;
    htmlWidgetDownload: string;
    htmlWidgetViewCode: string;
    htmlWidgetViewPreview: string;
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
    imageExpired: string;
    inputTokens: string;
    outputTokens: string;
    addAttachment: string;
    // Conversation ID badge
    copyConvIdTooltip: string;
    copyConvIdCopied: string;
    // Message time / day separator
    timeJustNow: string;
    timeMinutesAgo: string;
    dayToday: string;
    dayYesterday: string;
    dayBeforeYesterday: string;
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
    // Context warning bar
    contextWarning: string;
    contextCritical: string;
    contextCompressBtn: string;
    contextNewChatBtn: string;
    // Agent loop max turns
    maxTurnsReached: string;
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
    // Permission mode
    permissionMode: string;
    permissionModeDesc: string;
    // Content Guard kill switch (Task #26)
    contentGuardTitle: string;
    contentGuardDesc: string;
    contentGuardDisableTitle: string;
    contentGuardDisableMessage: string;
    permissionModeDefault: string;
    permissionModeDefaultDesc: string;
    permissionModeAuto: string;
    permissionModeAutoDesc: string;
    permissionModeStrict: string;
    permissionModeStrictDesc: string;
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

    // Provider Management V2
    addService: string;
    serviceName: string;
    serviceNameAuto: string;
    selectProviderType: string;
    searchProvider: string;
    alreadyAdded: string;
    cloudProviders: string;
    localProviders: string;
    customProviders: string;
    guide: string;
    guideGoTo: string;
    apiKeyRequired: string;
    apiKeyOptional: string;
    apiUrlNoChange: string;
    apiUrlPreview: string;
    fetchModels: string;
    fetchingModels: string;
    fetchModelsError: string;
    fetchModelsSuccess: string;
    addModelManually: string;
    addModelPlaceholder: string;
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
    auxiliary: string;
    auxiliarySearch: string;
    auxiliaryImageGen: string;
    builtinVia: string;
    providerEnabled: string;
    providerDisabled: string;
    cancelEdit: string;
    saveChanges: string;
    customApiOpenai: string;
    customApiAnthropic: string;
    models: string;
    modelsCount: string;
    capabilitiesLabel: string;
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
    feedbackDesc: string;
    sponsor: string;
    sponsorDesc: string;
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
  };

  // Tool error messages (used in core/tools/registry.ts)
  toolErrors: {
    userDeniedAccess: string;
    pathAccessDenied: string;
    needsAuthorization: string;
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
    migrationBanner: string;
    migrationAction: string;
    migrationDismiss: string;
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
