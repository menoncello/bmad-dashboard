export type BmadModule = {
  name: string
  version?: string
  source?: string
  repoUrl?: string
  npmPackage?: string
  channel?: string
  installDate?: string
  lastUpdated?: string
}

export type BmadAgent = { code: string; name?: string; title?: string; icon?: string; module?: string; description?: string }

export type BmadSkill = { name: string; module?: string; description?: string; phase?: string; menuCode?: string; required?: boolean }

export type BmadStory = {
  key: string
  epic: number
  num: string
  title?: string
  status: string
  file?: string
  format?: 'spec' | 'legacy'
  fileStatus?: string
  type?: string
  // v7 tickets only
  risk?: string
  blockedReason?: string
  route?: string
  tasksDone?: number
  tasksTotal?: number
  reviewOpen?: number
  reviewDone?: number
  updatedMs?: number
}

export type BmadEpic = {
  num: number
  title?: string
  status: string
  retro?: string
  retroVerdict?: string
  retroFile?: string
  stories: BmadStory[]
}

export type BmadActionItem = { id?: string; epic?: string; action: string; owner?: string; status: string; ref?: string }

export type BmadArtifact = {
  path: string
  kind: string
  title?: string
  status?: string
  updated?: string
  created?: string
  steps?: number
  lastStep?: string
  workflow?: string
  verdict?: string
  mtimeMs: number
  extra?: Record<string, string>
}

export type BmadDeferred = { id: string; title: string; severity?: string; status: string; origin?: string }

export type BmadLoopTask = {
  storyKey: string
  epic?: string
  phase: string
  attempt?: number
  reviewCycle?: number
  generation?: number
  tokensRaw: number
  tokensWeighted: number
  commit?: string
  deferReason?: string
  sessions: number
}

export type BmadLoopEvent = { ts: number; kind: string; story?: string; detail?: string }

export type BmadLoopRun = {
  runId: string
  ref: string
  runType?: string
  source?: string
  startedAt?: string
  status: string
  pid?: number
  pausedStage?: string
  pausedReason?: string
  pausedStory?: string
  crashError?: string
  stopRequested?: string
  currentStory?: string
  currentPhase?: string
  activeTask?: string
  activeRole?: string
  activeAdapter?: string
  heartbeatAgeS?: number
  remainingS?: number
  idle?: boolean
  pendingDecision?: string
  tokensRaw: number
  tokensWeighted: number
  attention: string[]
  tasks: BmadLoopTask[]
  events: BmadLoopEvent[]
  counts: Record<string, number>
}

export type BmadLoop = {
  installed: boolean
  policy?: Record<string, string>
  runs: BmadLoopRun[]
}

export type BmadGit = { branch?: string; dirty: number; ahead?: number; behind?: number; lastCommit?: string; lastCommitAgo?: string }

export type BmadGate = { target: string; status: string; file: string; evaluatedAt?: string; criticalOpen?: number; coverage?: string }

export type BmadQualitySummary = {
  byKind: Record<string, number>
  gates: BmadGate[]
  reviews: { target: string; score?: number; grade?: string; recommendation?: string; file: string }[]
  academy?: { user?: string; sessions: { name: string; status: string; score?: number }[] }
}

export type BmadDesignPage = { scenario?: string; step?: string; page: string; status: string; updated?: string }

export type BmadWds = {
  root: string
  current: string[]
  backlogOpen: number
  backlogDone: number
  pages: BmadDesignPage[]
  deliveries: { id: string; name?: string; status?: string; priority?: string }[]
  phases: { name: string; status: string }[]
}

export type BmadOrchestration = {
  file: string
  epic?: string
  name?: string
  status?: string
  currentStory?: string
  currentStep?: string
  lastUpdated?: string
  active: number
  completed: number
}

export type BmadBuilderSkill = { name: string; verdict?: string; grade?: string; analyzedAt?: string; inProgress: boolean }

export type BmadSnapshot = {
  at: number
  ms: number
  root: string
  found: boolean
  project: {
    name?: string
    user?: string
    language?: string
    docLanguage?: string
    skillLevel?: string
    bmadVersion?: string
    // v6 installs have _bmad/_config/manifest.yaml, v7 ones only bmod.toml files
    layout?: 'v6' | 'v7'
    installDate?: string
    lastUpdated?: string
    ides: string[]
  }
  paths: Record<string, string>
  modules: BmadModule[]
  agents: BmadAgent[]
  skills: BmadSkill[]
  sprint?: {
    file: string
    generated?: string
    lastUpdated?: string
    stale: boolean
    counts: Record<string, number>
    epics: BmadEpic[]
    actionItems: BmadActionItem[]
  }
  storiesOutsideSprint: BmadStory[]
  planning: BmadArtifact[]
  quality: BmadArtifact[]
  qualitySummary: BmadQualitySummary
  workflowStatus: Record<string, Record<string, string>>
  wds?: BmadWds
  orchestrations: BmadOrchestration[]
  automatorActive?: Record<string, string>
  builder: BmadBuilderSkill[]
  creative: BmadArtifact[]
  other: BmadArtifact[]
  inProgressSessions: BmadArtifact[]
  deferred: BmadDeferred[]
  buildAuto: { total: number; byStatus: Record<string, number>; latest: BmadArtifact[] }
  changeProposals: BmadArtifact[]
  loop: BmadLoop
  git?: BmadGit
  errors: string[]
}

export type BmadProjectSummary = {
  root: string
  name?: string
  lastSeen: number
  done?: number
  total?: number
  inProgress?: string
  loop?: string
}

declare module 'claude-code' {
  interface PluginState {
    'bmad-dashboard': {
      snapshot: BmadSnapshot | null
      tab: string
      epic: number
      loading: boolean
      projects: BmadProjectSummary[]
      root: string
    }
  }
}
