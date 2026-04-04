import z from "zod"

export const ConsoleState = z.object({
  consoleManagedProviders: z.array(z.string()),
  activeOrgName: z.string().optional(),
})

export type ConsoleState = z.infer<typeof ConsoleState>

export const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  activeOrgName: undefined,
}
