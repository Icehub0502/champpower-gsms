export interface Vehicle {
  id: string;
  customerId: string;
  plate: string;
  province?: string;
  brand: string;
  model: string;
  year?: string;
  color?: string;
  mileage?: string;
}

export interface Customer {
  id: string;
  name?: string;
  phone?: string;
}
