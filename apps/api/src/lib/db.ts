/**
 * The application's connection.
 *
 * DATABASE_URL is the gsms_app role: no CREATE on the schema, and row-level
 * security applies to it. Connecting as the superuser here would make every
 * tenant policy in the schema stop applying, silently, while all the tests
 * still pass — which is why the admin URL is never read from this file.
 *
 * The role is NOT checked here. This module is imported, and an import must
 * not do asynchronous work; the real check asks the server who it is and lives
 * in lib/startupChecks.ts, called from index.ts before the port opens.
 */
import { createDb } from '@gsms/db/client.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

export const db = createDb(url)
