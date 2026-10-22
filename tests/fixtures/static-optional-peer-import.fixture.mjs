// Negative control for the probe: this module must fail to load while the probe blocks
// optional peers. Never imported by the plugin itself.
import '@deepseek-ai/dsh-llm-deepseek'
export const loaded = true
