# Agents & Skills ที่ใช้งานได้ตอนนี้

> อัปเดตล่าสุด: 2026-07-25
> ไฟล์นี้เป็นรายการอ้างอิงเฉย ๆ ไม่ใช่ config — ใช้เรียก agent ผ่าน Task tool และเรียก skill ผ่าน `/<skill-name>`

---

## Agents

### สาย Planning / Architecture
| Agent | ใช้ทำอะไร |
|---|---|
| `tech-lead` | วางแผนงาน แตกงานเป็น task ย่อย มอบหมายให้ specialist agent (ตาม CLAUDE.md ให้เริ่มงานใหญ่ที่ตัวนี้ก่อน) |
| `solution-architect` | ตัดสินใจดีไซน์ระบบระดับสูง เลือกเทคโนโลยี, data flow, component boundary |
| `Plan` | ออกแบบแผน implementation แบบ step-by-step |
| `product-analyst` | แปลง feature request ที่คลุมเครือให้เป็น requirement/acceptance criteria ที่ชัดเจน |

### สาย Frontend
| Agent | ใช้ทำอะไร |
|---|---|
| `frontend-engineer` | React/Vite UI, state, responsive, accessibility (ตัวหลักตาม CLAUDE.md) |
| `expert-react-frontend-engineer` | React 19 เฉพาะทาง hooks/Server Components/Actions ขั้นสูง |
| `react-performance-optimizer` | Bundle size, rendering performance, Core Web Vitals |
| `expert-nextjs-developer` / `nextjs-architecture-expert` | เฉพาะโปรเจกต์ที่ใช้ Next.js (ไม่ตรงกับ stack ปัจจุบันที่เป็น Vite) |
| `accessibility` / `web-accessibility-checker` | ตรวจ WCAG compliance |
| `aem-frontend-specialist`, `electron-angular-native`, `wordpress-master`, `java-mcp-expert`, `lingodotdev-i18n` | เฉพาะ stack อื่น (AEM, Electron+Angular, WordPress, Java MCP, i18n) — ไม่เกี่ยวกับโปรเจกต์นี้โดยตรง |

### สาย Backend / API
| Agent | ใช้ทำอะไร |
|---|---|
| `api-designer` | ออกแบบ/รีวิว REST API, request/response schema, status code |
| *(ไม่มี `backend-engineer` โดยตรง)* | งาน Express.js/backend logic ทั่วไปทำในบทสนทนาหลัก หรือใช้ `api-designer` เฉพาะเรื่อง API |

### สาย Database
| Agent | ใช้ทำอะไร |
|---|---|
| `database-engineer` | Schema, index, SQL, migration ทั่วไป (ตัวหลักตาม CLAUDE.md) |
| `database-architect` | ออกแบบ schema ใหม่ตั้งแต่ต้น (greenfield), เลือกเทคโนโลยี DB |
| `database-optimizer` | วิเคราะห์ query ช้าเฉพาะจุด, execution plan, indexing |
| `database-administrator` | HA, replication, disaster recovery, DB infra ระดับ production (เกินความจำเป็นสำหรับระบบขนาดนี้) |

### สาย Debug / Security / Performance
| Agent | ใช้ทำอะไร |
|---|---|
| `debugger` | หา root cause ของบั๊ก ไม่ patch มั่ว |
| `security-auditor` | ตรวจ auth, secret, input validation, dependency |
| `performance-engineer` | slow SQL, memory leak, rendering ช้า |
| `observability-engineer` | logging, metrics, tracing, health check |
| `devops-engineer` | CI/CD, Docker, deploy config |

### สาย QA / Review
| Agent | ใช้ทำอะไร |
|---|---|
| `test-engineer` | เขียน/รันเทส frontend, backend, API, regression |
| `code-reviewer` | รีวิวคุณภาพโค้ด (ไม่แก้โค้ดเอง) |
| `refactorer` | ปรับโครงสร้างโค้ด ไม่เปลี่ยน behavior |
| `technical-writer` | เขียน README, API docs, changelog |

### สาย SEO / Content
| Agent | ใช้ทำอะไร |
|---|---|
| `seo-analyzer`, `search-ai-optimization-expert` | SEO/AEO/GEO audit |
| `url-context-validator`, `url-link-extractor` | ตรวจสอบ/สกัด URL ในโค้ด |
| `se-responsible-ai-code` | bias/accessibility/ethical AI review |

### อื่น ๆ
| Agent | ใช้ทำอะไร |
|---|---|
| `claude` | catch-all ทั่วไป |
| `claude-code-guide` | ถามเรื่อง Claude Code / Agent SDK / Claude API เอง |
| `general-purpose` | งาน research/multi-step ทั่วไป |
| `Explore` | ค้นหาไฟล์/symbol แบบ read-only เร็ว ๆ |
| `statusline-setup` | ตั้งค่า status line ของ Claude Code |

---

## Skills (เรียกด้วย `/<ชื่อ>`)

| Skill | ใช้ทำอะไร |
|---|---|
| `frontend-design` | สร้าง UI/component/หน้าเว็บที่ดีไซน์ดี ไม่ generic |
| `progressive-web-app` | ทำ PWA: service worker, manifest, offline cache |
| `dataviz` | สร้าง chart/graph/dashboard ให้ดูเป็นระบบเดียวกัน |
| `generate-tests` | สร้างไฟล์เทสให้ไฟล์/component ที่ระบุ |
| `run` | รัน/สตาร์ทแอป แล้วเช็คว่าใช้งานได้จริงในเบราว์เซอร์ |
| `review` | รีวิว GitHub PR |
| `security-review` | ตรวจ security ของ diff ปัจจุบันบน branch |
| `simplify` | รีวิวโค้ดที่เพิ่งแก้เพื่อลด complexity/ซ้ำซ้อน (ไม่หาบั๊ก) |
| `init` | สร้าง CLAUDE.md ใหม่จากการสำรวจโค้ด |
| `update-config` | แก้ settings.json ของ Claude Code (permission, hook, env var) |
| `keybindings-help` | ปรับ keyboard shortcut ของ Claude Code |
| `fewer-permission-prompts` | ลด permission prompt โดยเพิ่ม allowlist ให้อัตโนมัติ |
| `loop` | รัน prompt/slash command ซ้ำตามช่วงเวลา |
| `schedule` | ตั้ง scheduled cloud agent (cron) |
| `claude-api` | อ้างอิง Claude API/SDK (model, pricing, caching, tool use) |
| `artifact-design` / `artifact-capabilities` | แนวทางออกแบบ/runtime capability ของ Artifact |
| `anthropic-skills:docx` | สร้าง/แก้ไฟล์ Word (.docx) |
| `anthropic-skills:xlsx` | สร้าง/แก้ไฟล์ Excel (.xlsx/.csv) |
| `anthropic-skills:pptx` | สร้าง/แก้ไฟล์ PowerPoint |
| `anthropic-skills:pdf` | จัดการไฟล์ PDF (extract, merge, split, watermark) |
| `anthropic-skills:morning` | สรุป morning brief แบบ artifact |
| `anthropic-skills:schedule` | สร้าง/แก้ scheduled task |
| `anthropic-skills:setup-cowork` | ตั้งค่า Cowork (ติดตั้ง plugin, เชื่อมต่อเครื่องมือ) |
| `anthropic-skills:skill-creator` | สร้าง/แก้ไข skill ใหม่ |
| `anthropic-skills:consolidate-memory` | รวม/ทำความสะอาด memory file ที่ซ้ำซ้อน |

---

## หมายเหตุการใช้งานกับโปรเจกต์นี้ (stock-system)

- Stack จริง: React + Vite + Express.js + MySQL → agent ที่ตรงกับ CLAUDE.md ที่สุดคือ `tech-lead`, `frontend-engineer`, `database-engineer`, `debugger`, `security-auditor`, `performance-engineer`, `test-engineer`, `code-reviewer`
- Agent สาย database มี 4 ตัวทับซ้อนกัน (`database-engineer`, `database-architect`, `database-optimizer`, `database-administrator`) — ใช้ `database-engineer` เป็นค่าเริ่มต้น เว้นแต่งานเข้าเงื่อนไขเฉพาะของอีก 3 ตัว
- Agent สาย Next.js/AEM/WordPress/Electron ไม่เกี่ยวกับ stack นี้ ไม่ต้องเรียกใช้
- ไม่มี `backend-engineer` โดยตรง — งาน Express.js ทำในบทสนทนาหลัก หรือใช้ `api-designer` เฉพาะเรื่อง endpoint design
