import type {
  ChatNodeStore, ConversationSnapshot, ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import { conversationContextKey } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../contract/chat-nodes.ts'

interface IndexedChatNodeStore {
  getToolCall(callId: string): { readonly block: ToolCallBlock; readonly rootNodeKey: string } | undefined
}

function indexedStore(store: ChatNodeStore): Partial<IndexedChatNodeStore> {
  return store as ChatNodeStore & Partial<IndexedChatNodeStore>
}

function toolNode(node: ReturnType<ConversationSnapshot['chat']['nodes']['get']>): ChatNode<'tool-call'> | undefined {
  return node?.kind === 'tool-call' ? node as ChatNode<'tool-call'> : undefined
}

/**
 * Read one root Tool lifecycle through the internal Chat Node index.
 * @param snapshot - current Conversation snapshot.
 * @param rootCallId - root call identity and Tool Context identity.
 * @returns root lifecycle when it is materialized in the current window.
 */
export function rootToolCall(
  snapshot: ConversationSnapshot,
  rootCallId: string,
): ToolCallBlock | undefined {
  return toolNode(snapshot.chat.nodes.get(conversationContextKey('tool-call', rootCallId)))?.data.root
}

/**
 * Find any root or nested Tool lifecycle through the internal Node store.
 * @param snapshot - current Conversation snapshot.
 * @param callId - root or nested call identity.
 * @returns current Tool lifecycle when materialized in the loaded window.
 */
export function findToolCall(snapshot: ConversationSnapshot, callId: string): ToolCallBlock | undefined {
  return indexedStore(snapshot.chat.nodes).getToolCall?.(callId)?.block
}

/**
 * Resolve the Chat Node key owning a Tool call through a package-local store capability.
 * @param store - stable Chat Node store for the loaded window.
 * @param callId - root or nested call identity.
 * @returns owning root Node key when indexed.
 */
export function rootNodeKeyForToolCallStore(store: ChatNodeStore, callId: string): string | undefined {
  return indexedStore(store).getToolCall?.(callId)?.rootNodeKey
}
