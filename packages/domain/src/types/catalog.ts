export interface MasterPart {
  id: string;
  name: string;
  category: string;
}

export interface ModelPartBrand {
  id: string;
  name: string;
  price?: string;
}

export interface ModelPart {
  id: string;
  partName: string;
  category?: string;
  qty?: string;
  unit?: string;
  variant?: string;
  brands: ModelPartBrand[];
}

export interface Promotion {
  id: string;
  name: string;
  itemIds: string[];
  price?: string;
  dateStart?: string;
  dateEnd?: string;
  mileageStart?: string;
  mileageEnd?: string;
}

export interface VehicleModel {
  id: string;
  brand: string;
  name: string;
  yearRange?: string;
  seedKey?: string;
  parts: ModelPart[];
  promotions?: Promotion[];
}
