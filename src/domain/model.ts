import {
  ALIGNMENTS,
  CREATURE_ID,
  CHARACTER_IDS,
  DECISION_KIND_SCHEMAS,
  DECISION_SCHEMA_KEYS,
  GAME_PHASES,
  PLAYER_IDS,
  ROLE_IDS,
  WITCH_SKILL_IDS,
} from '../../shared/gamePromptContract.js';

export type CreatureId = typeof CREATURE_ID;
export type PlayerId = (typeof PLAYER_IDS)[number] | CreatureId;
export type CharacterId = (typeof CHARACTER_IDS)[number];
export type RoleId = (typeof ROLE_IDS)[number];
export type Alignment = (typeof ALIGNMENTS)[number];
export type WitchSkillId = (typeof WITCH_SKILL_IDS)[number];

export type GameMode = 'spectator' | 'player';
export type AutomationMode = 'remote' | 'local';
export type GamePhase = (typeof GAME_PHASES)[number];

export type SkillTiming =
  | 'night-start'
  | 'night-protection'
  | 'on-death'
  | 'day-start'
  | 'before-speech'
  | 'after-speech'
  | 'on-mention'
  | 'before-vote'
  | 'after-vote'
  | 'after-runoff';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DecisionTraits {
  conservative: number;
  trusting: number;
  aggressive: number;
}

export interface CharacterDefinition {
  id: CharacterId;
  name: string;
  personality: string;
  speechStyle: string;
  examplePhrases: string[];
  decisionTraits: DecisionTraits;
  avatarUrl: string;
}

export interface PlayerState {
  id: PlayerId;
  characterId: CharacterId;
  roleAssignmentId: string;
  skillInstanceId: string | null;
  alive: boolean;
}

/** 诺亚的造物（忆灵）：液态分身，继承诺亚的基础职业，不继承魔女技。 */
export interface CreatureState {
  id: CreatureId;
  ownerPlayerId: PlayerId;
  characterId: CharacterId;
  roleAssignmentId: string;
  alive: boolean;
  /** 造物持有的药（创造时诺亚二选一给解药/毒药） */
  resources: RoleResources;
}

export interface RoleResources {
  antidote?: 0 | 1;
  poison?: 0 | 1;
}

export interface RoleAssignmentState {
  id: string;
  ownerPlayerId: PlayerId;
  roleId: RoleId;
  resources: RoleResources;
}

export interface WitchSkillInstance {
  id: string;
  definitionId: WitchSkillId;
  ownerPlayerId: PlayerId;
  status: 'ready' | 'active' | 'exhausted';
  remainingUses: number | null;
  data: Record<string, JsonValue>;
}

export interface KnowledgeFact {
  id: string;
  subjectPlayerId: PlayerId;
  kind: 'role' | 'alignment' | 'skill';
  value: RoleId | Alignment | WitchSkillId;
  observedDay: number;
  sourceEventId: string;
}

export type TimelineEventKind =
  | 'system'
  | 'skill'
  | 'knowledge'
  | 'wolf-suggestion'
  | 'wolf-attack'
  | 'witch-action'
  | 'seer-check'
  | 'protection'
  | 'death'
  | 'dawn'
  | 'speech'
  | 'restrained'
  | 'last-words'
  | 'vote'
  | 'exile'
  | 'trial-by-fire'
  | 'role-exchange'
  | 'factor-recovered'
  | 'timeline-rewound'
  | 'result'
  | 'post-game-speech';

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  day: number;
  phase: GamePhase;
  text: string;
  actorPlayerId: PlayerId | null;
  targetPlayerIds: PlayerId[];
  displayAuthorPlayerId: PlayerId | null;
  actualAuthorPlayerId: PlayerId | null;
  data: Record<string, JsonValue>;
}

export interface PrivateTimelineEvent extends TimelineEvent {
  viewerPlayerIds: PlayerId[];
}

export interface ArchivedTimeline {
  id: string;
  rewoundAtDay: number;
  publicEvents: TimelineEvent[];
  privateEvents: PrivateTimelineEvent[];
}

export interface VoteRecord {
  voterPlayerId: PlayerId;
  targetPlayerId: PlayerId | null;
  round: 1 | 2;
}

export interface DeathIntent {
  targetPlayerId: PlayerId;
  source: 'wolf' | 'poison' | 'precise-kill';
  preventable: boolean;
}

export type DecisionSchemaKey = (typeof DECISION_SCHEMA_KEYS)[number];

export type PendingDecisionKind = keyof typeof DECISION_KIND_SCHEMAS;

export interface PendingDecision {
  id: string;
  kind: PendingDecisionKind;
  schemaKey: DecisionSchemaKey;
  actorId: PlayerId;
  title: string;
  description: string;
  candidates: PlayerId[];
  allowAbstain: boolean;
  skillInstanceId: string | null;
  options: Record<string, JsonValue>;
}

export interface TargetDecision {
  targetPlayerId: PlayerId | null;
}

export interface OptionalTargetDecision extends TargetDecision {
  use: boolean;
}

export interface SpeechDecision {
  speech: string;
}

export interface WolfCouncilDecision {
  message: string;
  recommendedTargetPlayerId: PlayerId;
}

export interface WitchDecision {
  save: boolean;
  poisonTargetPlayerId: PlayerId | null;
}

export interface LiquidControlDecision extends OptionalTargetDecision {
  mode: 'extract' | 'spread' | null;
  factId: string | null;
}

export interface LevitationDecision extends OptionalTargetDecision {
  mode: 'move-first' | 'move-last' | 'tie-break' | null;
}

export interface VoiceMimicDecision extends OptionalTargetDecision {
  forgedSpeech: string | null;
}

export interface IgnitionDecision {
  use: boolean;
}

export type SubmittedDecision =
  | TargetDecision
  | OptionalTargetDecision
  | SpeechDecision
  | WolfCouncilDecision
  | WitchDecision
  | LiquidControlDecision
  | LevitationDecision
  | VoiceMimicDecision
  | IgnitionDecision;

export interface GameResult {
  winner: Alignment;
  reason: 'wolves-eliminated' | 'parity';
  finishedDay: number;
}

export interface GameState {
  schemaVersion: 1;
  gameId: string;
  seriesId: string;
  roundNumber: number;
  board: string;
  mode: GameMode;
  automationMode: AutomationMode;
  usedFreeProvider: boolean;
  aiFailureOccurred: boolean;
  humanPlayerId: PlayerId | null;
  seed: number;
  rngState: number;
  day: number;
  phase: GamePhase;
  players: PlayerState[];
  creatures: CreatureState[];
  roleAssignments: RoleAssignmentState[];
  skillInstances: WitchSkillInstance[];
  knowledgeByPlayer: Record<PlayerId, KnowledgeFact[]>;
  speechOrder: PlayerId[];
  publicEvents: TimelineEvent[];
  privateEvents: PrivateTimelineEvent[];
  archivedTimelines: ArchivedTimeline[];
  currentVotes: VoteRecord[];
  pendingDecision: PendingDecision | null;
  morningCheckpoint: RewindSnapshot | null;
  causalLocks: string[];
  result: GameResult | null;
}
export type RewindSnapshot = Omit<GameState, 'morningCheckpoint' | 'causalLocks' | 'archivedTimelines' | 'usedFreeProvider' | 'aiFailureOccurred'>;

export interface GameSetup {
  mode: GameMode;
  humanCharacterId: CharacterId | null;
  playerCount: number;
  selectedCharacterIds: CharacterId[];
  seatCharacterIds?: CharacterId[];
  seed: number;
}

export type GameEvent =
  | { type: 'advance' }
  | { type: 'submit-decision'; pendingDecisionId: string; actorId: PlayerId; decision: SubmittedDecision }
  | { type: 'set-automation'; automationMode: AutomationMode }
  | { type: 'set-rng-state'; rngState: number }
  | { type: 'mark-free-provider-used' }
  | { type: 'mark-ai-failure' };

export interface GameCommand {
  type: 'decision';
  decision: PendingDecision;
}

export interface ObservedPlayer {
  id: PlayerId;
  characterId: CharacterId;
  name: string;
  avatarUrl: string;
  alive: boolean;
  roleId: RoleId | null;
  skillId: WitchSkillId | null;
  isSelf: boolean;
}

export interface GameObservation {
  gameId: string;
  mode: GameMode;
  automationMode: AutomationMode;
  board: string;
  seed: number;
  roundNumber: number;
  usedFreeProvider: boolean;
  aiFailureOccurred: boolean;
  day: number;
  phase: GamePhase;
  viewerPlayerId: PlayerId | null;
  omniscient: boolean;
  players: ObservedPlayer[];
  publicEvents: TimelineEvent[];
  privateEvents: PrivateTimelineEvent[];
  archivedTimelines: ArchivedTimeline[];
  knowledge: KnowledgeFact[];
  currentVotes: VoteRecord[];
  pendingDecision: PendingDecision | null;
  result: GameResult | null;
}

export interface WitchSkillDefinition {
  id: WitchSkillId;
  name: string;
  description: string;
  timings: SkillTiming[];
  usage: 'once' | 'nightly' | 'daily' | 'passive';
}
