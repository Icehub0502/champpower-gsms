export interface VehicleModelSeed {
  brand: string;
  name: string;
}

/**
 * The shop's own corrected 101-entry parts-catalogue model list, transcribed verbatim
 * from the original app (v3.0.0 — CATALOG_VEHICLE_MODELS). Rows that cover two models
 * at once ("TRITON 4WD, PAJERO", "VIGO 2WD, INNOVA '04-14") are kept as single entries
 * on purpose — one part fits both, and splitting them would break the lookup the shop
 * actually uses. Years stay inside the name rather than a separate yearRange field,
 * since inventing a range could contradict what's written.
 */
export const VEHICLE_MODELS: VehicleModelSeed[] = [
  { brand: 'CHEVROLET', name: "OPTRA '03-08" },
  { brand: 'CHEVROLET', name: "CRUZE '10-" },
  { brand: 'CHEVROLET', name: "CAPTIVA C100 '07-11" },
  { brand: 'CHEVROLET', name: "CAPTIVA C140 '12-15" },
  { brand: 'CHEVROLET', name: "AVEO (T250,T255) '07" },
  { brand: 'CHEVROLET', name: "SONIC '11" },
  { brand: 'CHEVROLET', name: 'ZAFIRA' },
  { brand: 'CHEVROLET', name: "COLORADO 2WD '12" },
  { brand: 'CHEVROLET', name: "COLORADO 4WD '12" },

  { brand: 'FORD', name: "FOCUS '02-07" },
  { brand: 'FORD', name: "FOCUS '10-12, '12-15" },
  { brand: 'FORD', name: "FIESTA '10" },
  { brand: 'FORD', name: "ECOSPORT '14" },
  { brand: 'FORD', name: 'RANGER 2WD' },
  { brand: 'FORD', name: 'RANGER 4WD' },
  { brand: 'FORD', name: "RANGER T6 '11 2WD" },
  { brand: 'FORD', name: "RANGER T6 '11 4WD" },
  { brand: 'FORD', name: 'EVEREST' },
  { brand: 'FORD', name: 'ESCAPE' },

  { brand: 'HONDA', name: "CITY '96-01" },
  { brand: 'HONDA', name: "CITY '03" },
  { brand: 'HONDA', name: "CITY, JAZZ (GD) '03-07" },
  { brand: 'HONDA', name: "CITY, JAZZ (GE) '08-13" },
  { brand: 'HONDA', name: "CITY, JAZZ (GK) '14-19" },
  { brand: 'HONDA', name: 'FREED' },
  { brand: 'HONDA', name: "BRIO '11" },
  { brand: 'HONDA', name: "CIVIC ES '01-05" },
  { brand: 'HONDA', name: "CIVIC FD '06-11" },
  { brand: 'HONDA', name: "CIVIC FB '12-16" },
  { brand: 'HONDA', name: "CIVIC FC '17-24" },
  { brand: 'HONDA', name: "CRV G3 '07-11" },
  { brand: 'HONDA', name: "CRV G4 '12-16" },
  { brand: 'HONDA', name: "HRV '14" },
  { brand: 'HONDA', name: "ACCORD G7 '03-07" },
  { brand: 'HONDA', name: "ACCORD G8 '08-12" },
  { brand: 'HONDA', name: "ACCORD G9 '13-" },

  { brand: 'HYUNDAI', name: 'H1' },

  { brand: 'ISUZU', name: 'D-MAX 2WD' },
  { brand: 'ISUZU', name: 'D-MAX 4WD HI-LANDER, MU-7' },
  { brand: 'ISUZU', name: "D-MAX 2WD '12" },
  { brand: 'ISUZU', name: "D-MAX 4WD '12, MU-X" },

  { brand: 'KIA', name: "CARNIVAL '98" },
  { brand: 'KIA', name: 'JUMBO 2700' },

  { brand: 'MAZDA', name: "BT50 PRO '12-15 2WD" },
  { brand: 'MAZDA', name: "BT50 PRO '12-15 4WD" },
  { brand: 'MAZDA', name: "MAZDA 3 '05-09" },
  { brand: 'MAZDA', name: "MAZDA 3 (BM) '13" },
  { brand: 'MAZDA', name: "MAZDA 2 (DE) '09-14" },
  { brand: 'MAZDA', name: "MAZDA 2 (DL) '15-22" },
  { brand: 'MAZDA', name: 'MAZDA CX3' },
  { brand: 'MAZDA', name: "MAZDA CX5 (KE) '13-16" },
  { brand: 'MAZDA', name: "MAZDA CX5 (KF) '17-20" },

  { brand: 'MG', name: "MG 3 '15-18" },
  { brand: 'MG', name: "MG ZS '17" },
  { brand: 'MG', name: "MG GS '18" },

  { brand: 'MITSUBISHI', name: "LANCER '90-05" },
  { brand: 'MITSUBISHI', name: "SPACE WAGON '09" },
  { brand: 'MITSUBISHI', name: "CEDIA '05" },
  { brand: 'MITSUBISHI', name: "LANCER EX '10" },
  { brand: 'MITSUBISHI', name: 'TRITON 2WD' },
  { brand: 'MITSUBISHI', name: 'TRITON 4WD, PAJERO' },
  { brand: 'MITSUBISHI', name: "TRITON '14 2WD" },
  { brand: 'MITSUBISHI', name: "TRITON '14 4WD, PAJERO" },
  { brand: 'MITSUBISHI', name: 'MIRAGE 1.2' },

  { brand: 'NISSAN', name: 'NAVARA D40T 2WD' },
  { brand: 'NISSAN', name: 'NAVARA 4WD' },
  { brand: 'NISSAN', name: 'NAVARA NP300 2WD, 4WD' },
  { brand: 'NISSAN', name: 'SUNNY SUPER NEO' },
  { brand: 'NISSAN', name: "TEANA J31 '03" },
  { brand: 'NISSAN', name: "TEANA J32 '08" },
  { brand: 'NISSAN', name: "TEANA L33 '14" },
  { brand: 'NISSAN', name: 'TIIDA' },
  { brand: 'NISSAN', name: "MARCH K13 '10, ALMERA K13 '12" },
  { brand: 'NISSAN', name: "SYLPHY (B17) '12" },

  { brand: 'SUBARU', name: "FORESTER '08-13" },
  { brand: 'SUBARU', name: "FORESTER '13-18" },
  { brand: 'SUBARU', name: "XV '12" },

  { brand: 'SUZUKI', name: "SWIFT '94" },
  { brand: 'SUZUKI', name: "SWIFT 1.5 '09-12" },
  { brand: 'SUZUKI', name: "SWIFT 1.2 '12-17" },

  { brand: 'TOYOTA', name: "VIGO 2WD, INNOVA '04-14" },
  { brand: 'TOYOTA', name: "VIGO 4WD, FORTUNER '04-14" },
  { brand: 'TOYOTA', name: 'REVO 2WD' },
  { brand: 'TOYOTA', name: 'REVO 4WD, FORTUNER' },
  { brand: 'TOYOTA', name: 'HIACE KDH200,222' },
  { brand: 'TOYOTA', name: 'COMMUTER' },
  { brand: 'TOYOTA', name: "COMMUTER '19 KDH223" },
  { brand: 'TOYOTA', name: "ALTIS '01-07" },
  { brand: 'TOYOTA', name: "ALTIS '08-13, '14" },
  { brand: 'TOYOTA', name: "CAMRY ACV30 '02-04" },
  { brand: 'TOYOTA', name: "CAMRY ACV40 '06" },
  { brand: 'TOYOTA', name: "CAMRY ACV50 '11" },
  { brand: 'TOYOTA', name: 'CH-R' },
  { brand: 'TOYOTA', name: 'SIENTA' },
  { brand: 'TOYOTA', name: 'PRIUS ZVW30' },
  { brand: 'TOYOTA', name: "ALPHARD '02" },
  { brand: 'TOYOTA', name: "HARRIER '03" },
  { brand: 'TOYOTA', name: "VIOS '02" },
  { brand: 'TOYOTA', name: "VIOS '07-11, YARIS '08" },
  { brand: 'TOYOTA', name: "VIOS '13, YARIS '14" },
  { brand: 'TOYOTA', name: 'AVANZA' },
  { brand: 'TOYOTA', name: "AVANZA '12-15" },
  { brand: 'TOYOTA', name: 'LAND CRUISER (100 J10)' },
];

/** brand|name — stable key so a RENAMED model isn't seen as missing and re-imported. */
export function seedKeyOf(brand: string, name: string): string {
  return `${brand}|${name}`;
}
