export interface ShopInfo {
  name: string;
  sub: string;
  phone: string;
  line: string;
  site: string;
}

export interface ShopSettings {
  aiApiKey: string;
  geminiApiKey: string;
  aiModel: 'claude' | 'gemini';
  themeId: string;
}

export interface TechnicianEntry {
  id: string;
  name: string;
}

export interface ShopConfig {
  shop: ShopInfo;
  settings: ShopSettings;
  technicians: TechnicianEntry[];
  deletedMasterPartNames: string[];
}
