import { router } from "./init.ts"
import { account } from "./procedures/account.ts"
import { channels } from "./procedures/channels.ts"
import { disputes } from "./procedures/disputes.ts"
import { hosts } from "./procedures/hosts.ts"
import { keys } from "./procedures/keys.ts"
import { usage } from "./procedures/usage.ts"
import { windows } from "./procedures/windows.ts"

export const appRouter = router({ account, keys, usage, channels, windows, disputes, hosts })

export type AppRouter = typeof appRouter
