import type { AgentPrincipal } from '../../shared/agent/v1/gatewayContracts';

export interface RendererIdentityAdapter {
  principal(): AgentPrincipal;
}
