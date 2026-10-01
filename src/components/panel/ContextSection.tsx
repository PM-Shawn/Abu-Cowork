import { useState, useMemo, useEffect } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
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
    <div>
      {/* Header */}
      <Pressable
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          <Icon icon={AppIcons.clock} className="text-label-secondary" />
          <span className="text-ui font-medium text-label">{t.panel.context}</span>
          {contextData.totalToolCalls > 0 && (
            <span className="text-ui-sm text-label-tertiary">
              {contextData.totalToolCalls} ops
            </span>
          )}
        </span>
        <Icon
          icon={AppIcons.expand}
          size="sm"
          className={cn('text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
        />
      </Pressable>

      {expanded && (
        <div className="mt-3">
          {hasContent ? (
            <div className="space-y-4">
              {/* Accessed Files - now with expandable content */}
              {contextData.accessedFiles.length > 0 && (
                <div>
                  <div className="mb-2 text-ui-sm text-label-tertiary">{t.panel.accessedFiles}</div>
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
                      <div className="text-caption text-label-tertiary">
                        {format(t.panel.moreFiles, { count: contextData.accessedFiles.length - 10 })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Tool Stats */}
              {Object.keys(contextData.toolStats).length > 0 && (
                <div>
                  <div className="mb-2 text-ui-sm text-label-tertiary">{t.panel.toolUsage}</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(contextData.toolStats).map(([tool, count]) => (
                      <Tag key={tool}>
                        <Icon icon={AppIcons.tool} size="sm" />
                        {formatToolName(tool)}
                        <span className="text-label-tertiary">x{count}</span>
                      </Tag>
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
            <div className="flex flex-col items-center py-4 text-center">
              <div className="mb-2 flex items-center gap-2">
                <div className="h-6 w-5 rounded-control bg-fill" />
                <div className="h-6 w-5 rounded-control bg-fill" />
                <div className="h-6 w-5 rounded-control bg-fill" />
              </div>
              <p className="text-ui-sm text-label-tertiary">
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

const OPERATION_ICON = {
  read: AppIcons.fileRead,
  write: AppIcons.fileEdit,
  execute: AppIcons.terminal,
} as const;

interface FileRowProps {
  file: AccessedFile;
  isExpanded: boolean;
  onToggle: () => void;
}

function FileRow({ file, isExpanded, onToggle }: FileRowProps) {
  const hasContent = !!file.content;

  // The disclosure arrow, or the same width left empty, so every name starts in one column.
  const body = (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {hasContent && <Icon icon={isExpanded ? AppIcons.expand : AppIcons.disclose} size="sm" />}
      </span>
      <Icon icon={OPERATION_ICON[file.operation]} size="sm" />
      <span className="truncate font-code">{getFileName(file.path)}</span>
    </>
  );

  return (
    <div>
      {hasContent ? (
        // The negative margin lets the hover fill reach past the text column.
        <div className="-mx-1">
          <Pressable
            onClick={onToggle}
            aria-expanded={isExpanded}
            className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left text-ui-sm text-label-tertiary hover:bg-fill-hover"
          >
            {body}
          </Pressable>
        </div>
      ) : (
        <div className="flex items-center gap-2 py-1 text-ui-sm text-label-tertiary">{body}</div>
      )}

      {/* Expanded content */}
      {isExpanded && hasContent && (
        <div className="ml-5 mt-1 rounded-control bg-code p-2">
          <pre className="max-h-50 overflow-y-auto whitespace-pre-wrap break-all font-code text-caption text-label-secondary">
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
      <Pressable
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          <Icon icon={AppIcons.plug} size="sm" className="text-label-tertiary" />
          <span className="text-ui-sm text-label-tertiary">{t.panel.connectors}</span>
          <span className="text-caption text-label-tertiary">
            {connectedCount}/{servers.length}
          </span>
        </span>
        <Icon
          icon={AppIcons.expand}
          size="sm"
          className={cn('text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
        />
      </Pressable>

      {expanded && (
        <div className="mt-2 space-y-1">
          {servers.map((server) => (
            <ConnectorRow key={server.config.name} server={server} />
          ))}
          {/* The one spinner of the connectors area; a reconnecting row shows a still icon */}
          {isLoading && <Spinner size="sm" label={t.panel.refreshing} />}
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

  // Every status mark sits in the same 16px box, so the names share one column.
  const renderStatusIcon = () => {
    if (status === 'connected') {
      return <Icon icon={AppIcons.plug} size="md" className="text-label-secondary" />;
    }
    if (status === 'reconnecting') {
      return <Icon icon={AppIcons.loading} size="md" className="text-label-tertiary" />;
    }
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="h-2 w-2 rounded-full border border-control-border" />
      </span>
    );
  };

  return (
    <div className="flex items-center gap-3 py-1">
      {renderStatusIcon()}
      <span className="text-ui text-label-tertiary">{config.name}</span>
      {status === 'connected' && tools.length > 0 && (
        <span className="text-caption text-label-tertiary">{tools.length} tools</span>
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
