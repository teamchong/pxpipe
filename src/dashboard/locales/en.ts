// Reference locale — English. Every other locale (src/dashboard/locales/<code>.ts)
// must implement this exact `Messages` shape; TypeScript will fail the build if a
// key is missing, so adding a language can never silently ship partial strings.
//
// See docs/TRANSLATING.md for how to add a new language.

export interface Messages {
  // ---- topbar ---------------------------------------------------------
  tagline: string;
  themeToLight: string; // button label when currently dark (switches to light)
  themeToDark: string; // button label when currently light (switches to dark)
  toggleThemeAria: string;
  switchToLightAria: string;
  switchToDarkAria: string;
  langSelectAria: string;

  // ---- compression kill switch -----------------------------------------
  passthroughBannerTitle: string;
  passthroughBannerBody: string;
  compressionOn: string;
  compressionOff: string;
  disableCompression: string;
  enableCompression: string;
  disableConfirm: string;
  killSwitchHint: string;

  // ---- model scope ------------------------------------------------------
  modelScopeSummary: string;
  modelScopeHint: string;
  modelScopeWarning: string;
  compressionOffNoEffect: string;
  imageClaudeModels: string;
  imageOpenAIModels: string;
  unlistedModelsHint: string;
  openAIModelsHint: string;
  pxpipeModelsCsvHint: string;
  routingScopeHint: string;
  routingHelpBtn: string;
  routingHelpTitle: string;
  routingHelpIntro: string;
  routingHelpEnvNote: string;
  routingHelpIdNote: string;
  routingHelpModelsNote: string;
  closeBtn: string;

  // ---- session hero -----------------------------------------------------
  sinceStartLabel: string;
  heroSinceStart: (requests: number, formatted: string) => string;
  heroWarmingUpTitle: string;
  heroWarmingUpBody: string;
  heroFewerTokens: string;
  heroMoreTokens: string;
  heroAfterCaching: string;
  heroSubline: (actual: string, baseline: string) => string;
  heroMeta: (output: string) => string;

  // ---- stat strip --------------------------------------------------------
  statRequests: string;
  statRequestsSub: (compressed: string) => string;
  statInputSaved: string;
  statInputSavedSub: string;
  statInputSavedTip: string;
  statEstSaved: string;
  statEstSavedSub: (rate: string) => string;
  statEstSavedTip: string;
  statCostPerRequest: string;
  statCostPerRequestSub: (without: string) => string;
  statCostPerRequestTip: string;
  statCostCollecting: string;
  statCostCollectingSub: string;
  statCostCollectingTip: string;

  // ---- math drawer --------------------------------------------------------
  showTheMath: string;
  drawerIntro: string;
  mathInputSavedTitle: string;
  mathDollarsSavedTitle: string;
  mathCostPerRequestTitle: string;
  mathShareOfSpendTitle: string;
  mathTokenEquivTitle: string;
  liveStatus: (port: number, uptime: string) => string;

  // ---- context map (image vs text breakdown) -------------------------------
  ctxPickDetailsEmpty: string;
  ctxNoLongerKept: string;
  ctxLatest: string;
  ctxSelected: string;
  ctxCachedText: string;
  ctxPlainText: string;
  ctxBecameImage: string;
  ctxStayedText: string;
  ctxCompressedInto: (chars: string, pages: number) => string;
  ctxNothingImaged: string;
  ctxImageAccuracyNote: string;
  ctxKeptAsTextLabel: string;
  ctxByteExact: string;
  ctxLatestMessages: string;
  ctxVerbatim: string;
  ctxModelReply: string;
  ctxNeverImagedNote: string;
  ctxModelFallback: string;
  /** !showCompare: no trustworthy text baseline yet — just report what was sent. */
  ctxHeadlineNoBaseline: (tokens: string) => string;
  /** Images billed smaller than the text counterfactual. */
  ctxHeadlineSmaller: (pct: number, textNoun: string, baseTokens: string, realTokens: string) => string;
  /** Images billed bigger than the text counterfactual. */
  ctxHeadlineBigger: (pct: number, realTokens: string, baseTokens: string, textNoun: string) => string;
  rcCompositionTitle: string;
  rcInstructions: string;
  rcSystemDeveloper: string;
  rcUserAssistant: string;
  rcToolsJson: string;
  rcFunctionCalls: string;
  rcFunctionOutputs: string;
  rcImageableFunctionOutputs: string;
  rcCollapsedFunctionOutputs: string;
  rcReasoningEncrypted: string;
  rcCompactionOpaque: string;
  rcOther: string;
  rcImageableBaseline: string;
  rcAdjacentPairs: string;
  rcOpenCalls: string;
  rcNativeImageParts: string;
  rcUnexplainedTokens: string;
  rcDiagnosticNote: string;
  ctxBucketStaticSlab: string;
  ctxBucketReminder: string;
  ctxBucketToolResultProse: string;
  ctxBucketToolResultLog: string;
  ctxBucketToolResultJson: string;
  ctxBucketHistory: string;
  ctxPagesSent: (n: number, model: string) => string;
  ctxPagesRestored: (n: number) => string;
  ctxNoTrustworthyBaseline: string;
  ctxColdNote: (rate: string, phrase: string) => string;
  ctxWarmShrunkNote: (pct: number, phrase: string) => string;
  ctxWarmNote: (phrase: string) => string;
  rawShrankPhrase: (pct: number) => string;
  rawGrewPhrase: (pct: number) => string;

  // ---- recent requests table ----------------------------------------------
  thHash: string;
  thResult: string;
  thEndpoint: string;
  thModel: string;
  thSentAs: string;
  thSentAsTip: string;
  thCacheHits: string;
  thCacheHitsTip: string;
  thAsText: string;
  thAsTextTip: string;
  thSent: string;
  thSentTip: string;
  thSavedLost: string;
  thSavedLostTip: string;
  noRequestsYet: string;
  detailsLink: string;
  badgeImage: string;
  badgeText: string;
  createTurnTip: (rate: number, tokens: string, readRate: number) => string;

  // ---- image / source inspector -------------------------------------------
  backToLatest: string;
  imageLabel: (id: number) => string;
  imageEvicted: (id: number) => string;
  noImagesYet: string;
  showSourceText: string;
  hideSourceText: string;
  sourceNotCaptured: string;
  pairWhatClaudeSees: string;
  pairMadeFrom: string;
  pairOriginalText: string;
  nativeSizeCaption: string;

  // ---- sessions bar chart --------------------------------------------------
  sessionsTracked: (n: number) => string;
  noSessionsYet: string;
  sessionsAxis: (shown: number, total: number) => string;

  // ---- full-history stats table --------------------------------------------
  eventsParsed: (n: string) => string;
  rowRequests: string;
  row2xx4xx5xx: string;
  rowCompressed: string;
  rowPassthrough: string;
  rowInputTokens: string;
  rowCacheCreate: string;
  rowCacheRead: string;
  rowCacheHitByTokens: string;
  rowCacheHitByEvents: string;
  rowOriginalChars: string;
  rowImageBytes: string;
  rowBytesPerChar: string;
  rowLatency: string;
  rowFirstByte: string;

  // ---- section headings ----------------------------------------------------
  sectionWhatHappened: string;
  sectionWhatHappenedSub: string;
  cardRecentRequests: string;
  cardImageVsText: string;
  cardInspector: string;
  sectionTopSessions: string;
  sectionTopSessionsSub: string;
  sectionFullHistory: string;
  sectionFullHistorySub: string;

  // ---- toasts / misc --------------------------------------------------------
  proxyUnreachable: (path: string) => string;
  /** Client-side prefix (JS string concatenation) — keep in sync with proxyUnreachable's wording. */
  proxyUnreachablePrefix: string;
  pageTitle: string;
}

export const en: Messages = {
  tagline: 'See exactly what got turned into images to shrink your Claude Code bill.',
  themeToLight: '☀ Light',
  themeToDark: '☾ Dark',
  toggleThemeAria: 'Toggle dark mode',
  switchToLightAria: 'Switch to light mode',
  switchToDarkAria: 'Switch to dark mode',
  langSelectAria: 'Choose dashboard language',

  passthroughBannerTitle: 'PASSTHROUGH MODE',
  passthroughBannerBody:
    'compression is off. Every request goes to Claude unchanged: no images, no savings. Use this to A/B test, or if the upstream API is having problems.',
  compressionOn: 'Compression on',
  compressionOff: 'Compression off',
  disableCompression: 'Disable compression',
  enableCompression: 'Enable compression',
  disableConfirm:
    'Turn compression off?\n\nRequests will pass straight through to Claude, unchanged. Restarting the proxy turns it back on.',
  killSwitchHint: 'kill switch · resets to on when you restart',

  modelScopeSummary: 'Image model scope',
  modelScopeHint: 'Fable 5 only by default · expand to experiment with other families',
  modelScopeWarning:
    '⚠ Image compression is tuned for Fable 5 only — other families can use more tokens, not less. Opt in only for deliberate experiments (custom system prompt, subagent model setup, …).',
  compressionOffNoEffect: 'compression is off — these settings have no effect right now',
  imageClaudeModels: 'Image Claude models',
  imageOpenAIModels: 'Image OpenAI Responses models',
  unlistedModelsHint: 'unlisted models get plain text',
  openAIModelsHint: 'opt-in · no Anthropic cache_control',
  pxpipeModelsCsvHint: 'CSV of bases, or off · applies on enter/blur · export to persist',
  routingScopeHint: 'imaging scope ≠ provider routing — non-Anthropic IDs also need routing env on the proxy',
  routingHelpBtn: 'routing help',
  routingHelpTitle: 'Routing Claude Code to OpenAI / Cloudflare models',
  routingHelpIntro:
    'Claude models use Anthropic by default. Two optional routes can run together — set on the pxpipe process (keep provider credentials out of Claude Code):',
  routingHelpEnvNote: 'If a model appears in both lists: CLOUDFLARE_MODELS > OPENAI_MODELS > default routing.',
  routingHelpIdNote:
    'Non-Anthropic IDs are advertised with a claude- prefix because Claude Code needs a Claude-shaped ID; pxpipe strips it before forwarding. Switch to one inside Claude Code with /model claude-<model> — e.g. /model claude-moonshotai/kimi-k3 — or launch with claude --model claude-moonshotai/kimi-k3. Verify discovery with curl …/v1/models.',
  routingHelpModelsNote:
    'PXPIPE_MODELS above is separate: it controls image compression, not routing. Kimi K3 on Cloudflare is the only non-Anthropic model tested end to end — see docs/CLAUDE_CODE_PROVIDER_ROUTING.md.',
  closeBtn: 'close',

  sinceStartLabel: 'Since start',
  heroSinceStart: (requests, formatted) => `Since start · ${formatted} request${requests === 1 ? '' : 's'} imaged`,
  heroWarmingUpTitle: 'Warming up…',
  heroWarmingUpBody:
    'Point Claude Code at this proxy and send a message. The moment a request flows through, your running savings show up right here.',
  heroFewerTokens: 'fewer tokens',
  heroMoreTokens: 'more tokens',
  heroAfterCaching: 'after caching',
  heroSubline: (actual, baseline) =>
    `<strong>${actual}</strong> effective tokens vs <strong>${baseline}</strong> if this same context stayed plain text — both counted after normal cache discounts since this proxy started. Your latest messages and Claude's live output are never compressed.`,
  heroMeta: (output) =>
    `Cache-aware — cached reads counted at their real ~0.1× weight, not full price · output untouched (${output}) · no $ assumptions`,

  statRequests: 'Requests',
  statRequestsSub: (compressed) => `${compressed} turned into images`,
  statInputSaved: 'Input tokens saved',
  statInputSavedSub: 'vs sending the same context as text',
  statInputSavedTip:
    'Bulky context (system prompt, tool output, old turns) sent as compact images instead of text. Cache-aware, input side only — recent turns and the live output stay text.',
  statEstSaved: 'Estimated saved',
  statEstSavedSub: (rate) => `at ${rate}/M base input price`,
  statEstSavedTip:
    'Cache-aware estimate using the server-reported 5-minute/1-hour write split when available (1.25×/2×), cache reads (0.10×), and the base input price.',
  statCostPerRequest: 'Cost per request',
  statCostPerRequestSub: (without) => `vs ${without} without pxpipe`,
  statCostPerRequestTip:
    'Average cost of paid imaged requests versus the cache-aware text counterfactual for those same requests. Unmeasured requests are assigned zero savings.',
  statCostCollecting: 'collecting…',
  statCostCollectingSub: 'waiting for a paid imaged request',
  statCostCollectingTip: 'The comparison appears after an imaged request returns provider usage.',

  showTheMath: 'Show the math & honesty receipts',
  drawerIntro:
    "Every number above, derived from the same per-event log. The proxy only moves <em>input</em> tokens; output is shown on both sides so percentages stay honest.",
  mathInputSavedTitle: 'Input tokens saved',
  mathDollarsSavedTitle: 'Dollars saved',
  mathCostPerRequestTitle: 'Cost per imaged request',
  mathShareOfSpendTitle: 'Share of total spend (diagnostic)',
  mathTokenEquivTitle: 'Token-equivalent (what the weekly cap counts)',
  liveStatus: (port, uptime) => `live · port ${port} · uptime ${uptime}`,

  ctxPickDetailsEmpty: 'Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.',
  ctxNoLongerKept: "That request's breakdown isn't kept anymore — only the most recent requests are. Pick <strong>Details</strong> on a newer row.",
  ctxLatest: 'Latest request',
  ctxSelected: 'Selected request',
  ctxCachedText: 'cached text',
  ctxPlainText: 'text',
  ctxBecameImage: 'Became an image',
  ctxStayedText: 'Stayed as text',
  ctxCompressedInto: (chars, pages) => `Compressed into images ${chars} chars · ${pages} page${pages === 1 ? '' : 's'}`,
  ctxNothingImaged: 'nothing imaged this request',
  ctxImageAccuracyNote: 'pxpipe can misread exact values inside images — treat these as gist, not byte-exact.',
  ctxKeptAsTextLabel: 'Kept as plain text',
  ctxByteExact: 'byte-exact',
  ctxLatestMessages: 'Your latest messages',
  ctxVerbatim: 'verbatim',
  ctxModelReply: "Model reply (output)",
  ctxNeverImagedNote: 'never imaged — safe for IDs, hashes and exact numbers.',
  ctxModelFallback: 'the model',
  ctxHeadlineNoBaseline: (tokens) => `<strong>${tokens}</strong> billing-equivalent input tokens sent`,
  ctxHeadlineSmaller: (pct, textNoun, baseTokens, realTokens) =>
    `<span class="ctx-big">${pct}%</span> smaller — ${textNoun} would bill as <strong>${baseTokens}</strong> input tokens; images billed as <strong>${realTokens}</strong>`,
  ctxHeadlineBigger: (pct, realTokens, baseTokens, textNoun) =>
    `<span class="ctx-big">${pct}%</span> bigger — images billed as <strong>${realTokens}</strong> input tokens vs <strong>${baseTokens}</strong> for ${textNoun}`,
  rcCompositionTitle: 'Original Responses composition (local o200k estimate)',
  rcInstructions: 'Instructions',
  rcSystemDeveloper: 'System / developer items',
  rcUserAssistant: 'User / assistant text kept native',
  rcToolsJson: 'Native tool JSON',
  rcFunctionCalls: 'Function calls',
  rcFunctionOutputs: 'Function outputs',
  rcImageableFunctionOutputs: 'Function outputs eligible in old closed pairs',
  rcCollapsedFunctionOutputs: 'Function outputs actually imaged this request',
  rcReasoningEncrypted: 'Reasoning / encrypted items',
  rcCompactionOpaque: 'Compaction / opaque items',
  rcOther: 'Other Responses items',
  rcImageableBaseline: 'Imageable text baseline',
  rcAdjacentPairs: 'Adjacent completed pairs (old / recent native / imaged)',
  rcOpenCalls: 'Open calls kept native',
  rcNativeImageParts: 'Native image parts',
  rcUnexplainedTokens: 'Provider tokens not explained locally',
  rcDiagnosticNote: 'This diagnostic uses local o200k counts only; it never calls Anthropic /count_tokens.',
  ctxBucketStaticSlab: 'System prompt + tool docs',
  ctxBucketReminder: 'System-reminder blocks',
  ctxBucketToolResultProse: 'Tool results — prose',
  ctxBucketToolResultLog: 'Tool results — logs',
  ctxBucketToolResultJson: 'Tool results — JSON',
  ctxBucketHistory: 'Older conversation turns',
  ctxPagesSent: (n, model) => `${n} image page${n === 1 ? '' : 's'} sent to ${model} — click one to read the exact text behind it:`,
  ctxPagesRestored: (n) => `${n} image page${n === 1 ? '' : 's'} were sent — thumbnails expired when the proxy restarted. The breakdown above is reconstructed from the saved log.`,
  ctxNoTrustworthyBaseline: 'Billed tokens count cache discounts (reads at 0.1×) — no trustworthy text baseline for this request yet.',
  ctxColdNote: (rate, phrase) =>
    `No warm text cache this turn — the text counterfactual's prefix is priced at the ${rate} create rate (the same event the imaged path pays), identical basis to the Saved column. The gap is purely token count. ${phrase}`,
  ctxWarmShrunkNote: (pct, phrase) =>
    `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. The raw text is ${pct}% smaller, but most of it would have been a cheap cache-read — so imaging it cost more.`,
  ctxWarmNote: (phrase) => `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. ${phrase}`,
  rawShrankPhrase: (pct) => `Raw content shrank ${pct}%.`,
  rawGrewPhrase: (pct) => `Raw content grew ${pct}%.`,

  thHash: '#',
  thResult: 'Result',
  thEndpoint: 'Endpoint',
  thModel: 'Model',
  thSentAs: 'Sent as',
  thSentAsTip: "Was this request's context compressed into an image?",
  thCacheHits: 'Cache hits',
  thCacheHitsTip: "Tokens served from Claude's cache (cheap)",
  thAsText: 'As text',
  thAsTextTip: 'Billing-equivalent input if kept as plain text, after cache create/read rates',
  thSent: 'Sent',
  thSentTip: 'Actual billing-equivalent input after imaging, after cache create/read rates',
  thSavedLost: 'Saved/lost',
  thSavedLostTip: 'As-text minus Sent; negative means imaging cost more',
  noRequestsYet: 'No requests yet — they stream in here live.',
  detailsLink: 'Details →',
  badgeImage: 'image',
  badgeText: 'text',
  createTurnTip: (rate, tokens, readRate) =>
    `Cache-create turn: this loss is the one-time ${rate}× premium for writing ${tokens} tokens to cache. Later turns re-read that prefix at ${readRate}×, which typically recoups it.`,

  backToLatest: '← back to latest',
  imageLabel: (id) => `image #${id}`,
  imageEvicted: (id) => `image #${id} is no longer in the buffer`,
  noImagesYet: 'No images yet — they appear the instant pxpipe compresses a request.',
  showSourceText: 'show the text behind this image',
  hideSourceText: 'hide source text',
  sourceNotCaptured: "source text wasn't captured for this image",
  pairWhatClaudeSees: 'What Claude sees · image',
  pairMadeFrom: 'made from ↓',
  pairOriginalText: 'The original text · byte-exact',
  nativeSizeCaption: 'top-left at native size',

  sessionsTracked: (n) => `${n} session${n === 1 ? '' : 's'} tracked`,
  noSessionsYet: 'No sessions yet.',
  sessionsAxis: (shown, total) => `tokens saved per session (cache-aware) · top ${shown} of ${total}`,

  eventsParsed: (n) => `${n} events parsed from disk`,
  rowRequests: 'requests',
  row2xx4xx5xx: '2xx / 4xx / 5xx',
  rowCompressed: 'compressed',
  rowPassthrough: 'passthrough',
  rowInputTokens: 'input tokens',
  rowCacheCreate: 'cache create',
  rowCacheRead: 'cache read',
  rowCacheHitByTokens: 'cache hit (by tokens)',
  rowCacheHitByEvents: 'cache hit (by events)',
  rowOriginalChars: 'original chars',
  rowImageBytes: 'image bytes',
  rowBytesPerChar: 'bytes / char',
  rowLatency: 'latency p50 / p95',
  rowFirstByte: 'first-byte p50 / p95',

  sectionWhatHappened: 'What happened to your context',
  sectionWhatHappenedSub: 'click a request to see image vs text',
  cardRecentRequests: 'Recent requests',
  cardImageVsText: 'Image vs text breakdown',
  cardInspector: 'Image ↔ source inspector',
  sectionTopSessions: 'Top sessions',
  sectionTopSessionsSub: 'by tokens saved',
  sectionFullHistory: 'Full history',
  sectionFullHistorySub: 'every event on disk',

  proxyUnreachable: (path) => `proxy unreachable: ${path}`,
  proxyUnreachablePrefix: 'proxy unreachable: ',
  pageTitle: 'pxpipe — live dashboard',
};
