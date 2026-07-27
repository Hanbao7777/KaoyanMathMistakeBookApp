export const agentApiVersion = 1 as const;
export const agentContractNamespace = 'kaoyan.agent.v1' as const;
export const agentContractVersion = `${agentContractNamespace}@${agentApiVersion}` as const;

export type AgentApiVersion = typeof agentApiVersion;
