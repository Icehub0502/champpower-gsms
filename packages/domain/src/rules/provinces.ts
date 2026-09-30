/**
 * The 77 Thai provinces — and, below, the 78 plate areas a vehicle may carry.
 *
 * Owner decision (29 Sep 2026): the same plate in two provinces is two
 * different cars, so vehicles are matched on (plate_key, province). That rule
 * only works if a province is ONE spelling. As free text, "กรุงเทพ",
 * "กรุงเทพมหานคร" and "กทม" would be three provinces, and one car would become
 * three the first week. So the API accepts exactly the names in PLATE_AREAS and
 * nothing else; the screen offers them as a picker.
 *
 * Official names, Bangkok as กรุงเทพมหานคร, sorted as Thai sorts them.
 *
 * This is the list of PROVINCES. What a plate carries is PLATE_AREAS below —
 * validate a vehicle's province against that, never against this.
 *
 * ONE LIST RULE: PLATE_AREAS is the single source of the values
 * vehicles.province may hold. The contract enum (packages/contracts Province),
 * normaliseProvince below, and any future DB CHECK constraint on
 * vehicles.province must all be derived from PLATE_AREAS — never a second
 * copy typed out somewhere else, which is how "เบตง accepted here, refused
 * there" happens.
 */
export const THAI_PROVINCES = [
  'กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น',
  'จันทบุรี', 'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร',
  'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก',
  'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี',
  'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์',
  'ปราจีนบุรี', 'ปัตตานี', 'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง',
  'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต',
  'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด',
  'ระนอง', 'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน',
  'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ',
  'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย',
  'สุพรรณบุรี', 'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง',
  'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี',
] as const;

export type ThaiProvince = (typeof THAI_PROVINCES)[number];

const OFFICIAL = new Set<string>(THAI_PROVINCES);

export function isThaiProvince(value: unknown): value is ThaiProvince {
  return typeof value === 'string' && OFFICIAL.has(value);
}

/**
 * Every value the area line of a Thai plate can carry: the 77 provinces plus
 * เบตง. THIS is the vocabulary of vehicles.province — the column keeps its name,
 * but what it holds is a plate area.
 *
 * Owner decision (30 Sep 2026): plates registered in เบตง (a district of ยะลา)
 * carry "เบตง" where the province goes, and they are their OWN registration
 * series. So เบตง is stored as itself and never mapped to ยะลา. Cars are matched
 * on (plate_key, province); folding เบตง into ยะลา would make a Betong car and a
 * Yala car with the same plate number one car, and hand one customer the
 * other's repair history — exactly what the pair key exists to stop.
 */
export const BETONG = 'เบตง' as const;

export const PLATE_AREAS = [...THAI_PROVINCES, BETONG] as const;

export type PlateArea = (typeof PLATE_AREAS)[number];

const AREAS = new Set<string>(PLATE_AREAS);

export function isPlateArea(value: unknown): value is PlateArea {
  return typeof value === 'string' && AREAS.has(value);
}

/**
 * Common ways a plate area gets WRITTEN, mapped to its official name.
 *
 * For the WO-004 data import and for the picker's search box. The prototype
 * stored free text; the import has to turn "กทม." into กรุงเทพมหานคร before it
 * writes a row, or a returning customer's car would not be found under its
 * official province. The API does NOT use this: it accepts only PLATE_AREAS, so
 * a picker — not a guess — decides what is stored going forward.
 *
 * Deliberately small: only variants that are unambiguous. Anything not
 * recognised returns null, and the importer must surface it for a person to
 * resolve rather than guess. Keys are lower-case with no spaces; see the lookup.
 */
const VARIANTS: Record<string, PlateArea> = {
  'กทม': 'กรุงเทพมหานคร',
  'กทม.': 'กรุงเทพมหานคร',
  'กรุงเทพ': 'กรุงเทพมหานคร',
  'กรุงเทพฯ': 'กรุงเทพมหานคร',
  'bangkok': 'กรุงเทพมหานคร',
  'อยุธยา': 'พระนครศรีอยุธยา',
  'โคราช': 'นครราชสีมา',
  // เบตง is its own plate area, NEVER ยะลา — see PLATE_AREAS.
  'ป้ายเบตง': BETONG,
  'betong': BETONG,
};

export function normaliseProvince(input: string | null | undefined): PlateArea | null {
  if (!input) return null;
  let s = input.trim().replace(/\s+/g, ' ');
  // "จังหวัดระยอง", "จ.ระยอง", "จ. ระยอง"
  s = s.replace(/^(จังหวัด|จ\.)\s*/, '');
  if (isPlateArea(s)) return s;
  // Case- and space-insensitive: "Betong", "BE TONG", "ป้าย เบตง" all land on
  // the same key.
  return VARIANTS[s.toLowerCase().replace(/\s+/g, '')] ?? null;
}
