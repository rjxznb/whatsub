export type Country = "US" | "UK" | "AU" | "CA";

export type Scene =
  | "immigration"
  | "housing"
  | "medical"
  | "campus"
  | "banking"
  | "shopping"
  | "transport"
  | "social"
  | "dining"
  | "emergency"
  | "job"
  | "phone"
  | "salon"
  | "driving"
  | "travel"
  | "fitness"
  | "mental_health"
  | "maintenance";

export const SCENE_LABELS: Record<Scene, string> = {
  immigration: "入境通关",
  housing: "住房安家",
  medical: "医疗健康",
  campus: "校园学习",
  banking: "银行财务",
  shopping: "日常购物",
  transport: "交通出行",
  social: "社交日常",
  dining: "餐饮",
  emergency: "紧急情况",
  job: "求职职场",
  phone: "电话沟通",
  salon: "美容美发",
  driving: "驾照开车",
  travel: "旅游度假",
  fitness: "运动健身",
  mental_health: "心理健康",
  maintenance: "搬家维修",
};

export interface Subtitle {
  time: number;
  endTime: number;
  text: string;
  translation: string;
  isKeyPoint: boolean;
  highlightWords: string[];
  keyNotes: Record<string, string>;
  highlightTranslations: Record<string, string>;
}

export type Register = "formal" | "casual" | "professional";
export type SpeakerRole = "learner" | "passive" | "both";
export type Difficulty = "EASY" | "MEDIUM" | "HARD";

export interface KeyPhrase {
  expression: string;
  meaningZh: string;
  usage: string;
  register: Register;
  speakerRole: SpeakerRole;
  minDifficulty: Difficulty;
}

export type Accent =
  | "American"
  | "American Female"
  | "British"
  | "British Female"
  | "Australian"
  | "Australian Female"
  | "Canadian"
  | "Canadian Female";

export interface RoleSetup {
  name: string;
  identity: string;
  personality: string;
  accent: Accent;
}

export interface AnalysisResult {
  sceneContext: string;
  subtitles: Subtitle[];
  keyPhrases: KeyPhrase[];
  roleSetup: RoleSetup;
  complications: { medium: string[]; hard: string[] };
  maxRounds: { easy: number; medium: number; hard: number };
  commonErrors: string[];
  culturalNotes: string;
  country: Country;
}

export interface SrtCue {
  index: number;
  time: number;
  endTime: number;
  text: string;
}
