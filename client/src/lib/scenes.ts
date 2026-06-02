// src/lib/scenes.ts
//
// The 18 official scene tags (canonical order) + their Chinese labels, shared
// by the corpus tag chips and the add-phrase form.

export const SCENE_ORDER = [
  "immigration",
  "housing",
  "medical",
  "campus",
  "banking",
  "shopping",
  "transport",
  "social",
  "dining",
  "emergency",
  "job",
  "phone",
  "salon",
  "driving",
  "travel",
  "fitness",
  "mental_health",
  "maintenance",
] as const;

export const SCENE_LABELS: Record<string, string> = {
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
