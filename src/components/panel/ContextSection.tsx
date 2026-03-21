import { useState, useMemo, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileSearch,
  FilePen,
  Terminal,
  Wrench,
  Clock,
  Plug,
  Circle,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { useActiveConversation } from '@/stores/chatStore';
import { useMCPStore, initMCPStoreSync, type MCPServerEntry } from '@/stores/mcpStore';
import { useI18n, format } from '@/i18n';
import { useShallow } from 'zustand/react/shallow';

interface AccessedFile {
  path: string;
  operation: 'read' | 'write' | 'execute';
  content?: string;  // Content from read_file result
}

/**
 * ContextSection - Shows accessed files (with expandable content), tool call statistics, and MCP connectors
 */
export default function ContextSection() {
  const [expanded, setExpanded] = useState(false);
  const [connectorsExpanded, setConnectorsExpanded] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const conversation = useActiveConversation();
  const mcpServers = useMCPStore(useShallow((s) => Object.values(s.servers)));
  const isLoadingMCP = useMCPStore((s) => s.isLoading);
  const { t } = useI18n();

  // Initialize MCP store sync on mount
  useEffect(() => {
    initMCPStoreSync();
  }, []);

  // Extract context data from messages, including file content from read_file results
  const contextData = useMemo(() => {
    if (!conversation) {
      return { accessedFiles: [], toolStats: {}, totalToolCalls: 0, usedMCPServers: new Set<string>() };
    }

    const accessedFiles: AccessedFile[] = [];
    const toolStats: Record<string, number> = {};
    const seenFiles = new Set<string>();
    const fileContents: Record<string, string> = {};
    const usedMCPServers = new Set<string>();

    for (const message of conversation.messages) {
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          // Count tool usage
          toolStats[tc.name] = (toolStats[tc.name] || 0) + 1;

          // Track MCP server usage (format: serverName__toolName)
          const sepIndex = tc.name.indexOf('__');
          if (sepIndex > 0) {
            usedMCPServers.add(tc.name.substring(0, sepIndex));
          }

          // Track file access
          const input = tc.input as Record<string, unknown>;
          const path = (input.path || input.file_path || input.filePath) as string | undefined;

          // Capture content from read_file results
          if (path && [TOOL_NAMES.READ_FILE, 'read', 'get_file_contents'].includes(tc.name)) {
            if (tc.result && typeof tc.result === 'string' && !tc.result.toLowerCase().startsWith('error:')) {
              fileContents[path] = tc.result;
            }
          }

          if (path && !seenFiles.has(path)) {
            seenFiles.add(path);
            let operation: 'read' | 'write' | 'execute' = 'read';

            if ([TOOL_NAMES.WRITE_FILE, 'write', TOOL_NAMES.EDIT_FILE, 'edit', 'create_file', 'create'].includes(tc.name)) {
              operation = 'write';
            } else if ([TOOL_NAMES.RUN_COMMAND, 'bash', 'execute', 'shell'].includes(tc.name)) {
              operation = 'execute';
            }

            accessedFiles.push({ path, operation });
          }
        }
      }
    }

    // Attach content to files
    for (const file of accessedFiles) {
      if (fileContents[file.path]) {
        file.content = fileContents[file.path];
      }
    }

    const totalToolCalls = Object.values(toolStats).reduce((a, b) => a + b, 0);

    return { accessedFiles, toolStats, totalToolCalls, usedMCPServers };
  }, [conversation]);

  // Toggle file expansion
  const toggleFileExpand = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Only show MCP servers that were actually used in this conversation
  const usedServers = mcpServers.filter((s) => contextData.usedMCPServers.has(s.config.name));
  const hasUsedMCPServers = usedServers.length > 0;
  const hasContent = contextData.totalToolCalls > 0 || hasUsedMCPServers;

  return (
    <div className="context-section">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center justify-between w-full text-left group"
      >
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
          <span className="text-[13px] font-medium text-[var(--abu-text-primary)]">{t.panel.context}</span>
          {contextData.totalToolCalls > 0 && (
            <span className="text-[12px] text-[var(--abu-text-muted)]">
              {contextData.totalToolCalls} ops
            </span>
          )}
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-[var(--abu-text-muted)] transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="mt-3">
          {hasContent ? (
            <div className="space-y-4">
              {/* Accessed Files - now with expandable content */}
              {contextData.accessedFiles.length > 0 && (
                <div>
                  <div className="text-[12px] text-[var(--abu-text-muted)] mb-2">{t.panel.accessedFiles}</div>
                  <div className="space-y-1">
                    {contextData.accessedFiles.slice(0, 10).map((file, i) => (
                      <FileRow
                        key={i}
                        file={file}
                        isExpanded={expandedFiles.has(file.path)}
                        onToggle={() => toggleFileExpand(file.path)}
                      />
                    ))}
                    {contextData.accessedFiles.length > 10 && (
                      <div className="text-[11px] text-[var(--abu-text-muted)]">
                        {format(t.panel.moreFiles, { count: contextData.accessedFiles.length - 10 })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tool Stats */}
              {Object.keys(contextData.toolStats).length > 0 && (
                <div>
                  <div className="text-[12px] text-[var(--abu-text-muted)] mb-2">{t.panel.toolUsage}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(contextData.toolStats).map(([tool, count]) => (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--abu-bg-muted)] text-[11px] text-[var(--abu-text-tertiary)]"
                      >
                        <Wrench className="h-3 w-3" />
                        {formatToolName(tool)}
                        <span className="text-[var(--abu-text-muted)]">x{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Connectors (MCP Servers) - only show servers used in this conversation */}
              {hasUsedMCPServers && (
                <ConnectorsSection
                  servers={usedServers}
                  expanded={connectorsExpanded}
                  onToggle={() => setConnectorsExpanded(!connectorsExpanded)}
                  isLoading={isLoadingMCP}
                  t={t}
                />
              )}
            </div>
          ) : (
            // Empty state - Claude Cowork style
            <div className="flex flex-col items-center py-4 text-center">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-6 rounded bg-[var(--abu-bg-hover)]" />
                <div className="w-5 h-6 rounded bg-[var(--abu-bg-hover)]" />
                <div className="w-5 h-6 rounded bg-[var(--abu-bg-hover)]" />
              </div>
              <p className="text-[12px] text-[var(--abu-text-muted)]">
                {t.panel.contextEmptyHint}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- File Row with expandable content ---

interface FileRowProps {
  file: AccessedFile;
  isExpanded: boolean;
  onToggle: () => void;
}

function FileRow({ file, isExpanded, onToggle }: FileRowProps) {
  const hasContent = !!file.content;

  const getIcon = () => {
    switch (file.operation) {
      case 'read':
        return <FileSearch className="h-3 w-3" />;
      case 'write':
        return <FilePen className="h-3 w-3" />;
      case 'execute':
        return <Terminal className="h-3 w-3" />;
    }
  };

  return (
    <div>
      <div
        role={hasContent ? 'button' : undefined}
        tabIndex={hasContent ? 0 : undefined}
        onClick={hasContent ? onToggle : undefined}
        onKeyDown={hasContent ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle()) : undefined}
        className={cn(
          'flex items-center gap-2 text-[12px] text-[var(--abu-text-tertiary)] py-0.5 rounded',
          hasContent && 'cursor-pointer hover:bg-[var(--abu-bg-muted)] -mx-1 px-1'
        )}
      >
        {hasContent ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 text-[var(--abu-text-muted)] shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-[var(--abu-text-muted)] shrink-0" />
          )
        ) : (
          <span className="w-3" />
        )}
        {getIcon()}
        <span className="truncate font-mono">{getFileName(file.path)}</span>
      </div>

      {/* Expanded content */}
      {isExpanded && hasContent && (
        <div className="ml-5 mt-1 p-2 bg-[var(--abu-bg-muted)] rounded border border-[var(--abu-bg-hover)]">
          <pre className="font-mono text-[11px] text-[var(--abu-text-tertiary)] whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
            {truncateContent(file.content!, 2000)}
          </pre>
        </div>
      )}
    </div>
  );
}

// --- Connectors Section ---

interface ConnectorsSectionProps {
  servers: MCPServerEntry[];
  expanded: boolean;
  onToggle: () => void;
  isLoading: boolean;
  t: ReturnType<typeof useI18n>['t'];
}

function ConnectorsSection({ servers, expanded, onToggle, isLoading, t }: ConnectorsSectionProps) {
  const connectedCount = servers.filter((s) => s.status === 'connected').length;

  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full text-left group"
      >
        <div className="flex items-center gap-2">
          <Plug className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
          <span className="text-[12px] text-[var(--abu-text-muted)]">{t.panel.connectors}</span>
          <span className="text-[11px] text-[var(--abu-text-muted)]">
            {connectedCount}/{servers.length}
          </span>
        </div>
        <ChevronDown
          className={cn(
            'h-3 w-3 text-[var(--abu-text-muted)] transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {servers.map((server) => (
            <ConnectorRow key={server.config.name} server={server} />
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--abu-text-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{t.panel.refreshing}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ConnectorRowProps {
  server: MCPServerEntry;
}

function ConnectorRow({ server }: ConnectorRowProps) {
  const { config, status, tools } = server;

  // Simple status icon - Claude Cowork style
  const renderStatusIcon = () => {
    if (status === 'connected') {
      return <Plug className="h-4 w-4 text-[var(--abu-text-tertiary)]" />;
    }
    if (status === 'reconnecting') {
      return <Loader2 className="h-4 w-4 text-[var(--abu-text-muted)] animate-spin" />;
    }
    return <Circle className="h-4 w-4 text-[var(--abu-text-placeholder)]" />;
  };

  return (
    <div className="flex items-center gap-3 py-1">
      {renderStatusIcon()}
      <span className="text-[13px] text-[var(--abu-text-tertiary)]">{config.name}</span>
      {status === 'connected' && tools.length > 0 && (
        <span className="text-[11px] text-[var(--abu-text-muted)]">{tools.length} tools</span>
      )}
    </div>
  );
}

// Extract filename from path
function getFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

// Format tool name for display
function formatToolName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace('Get System Info', 'System Info')
    .replace('List Directory', 'List Dir')
    .replace('Read File', 'Read')
    .replace('Write File', 'Write')
    .replace('Run Command', 'Run');
}

// Truncate content for display
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + `\n\n... (${content.length - maxLength} more characters)`;
}
