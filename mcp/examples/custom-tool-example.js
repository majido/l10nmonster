/**
 * Example: Creating and Registering a Custom MCP Tool
 * 
 * This example demonstrates how to create a custom MCP tool that extends
 * the L10n Monster MCP server with additional functionality.
 */

import { McpTool, McpInputError, Mcp } from '@l10nmonster/mcp';
import { z } from 'zod';

/**
 * Example custom tool that provides project statistics
 */
export class ProjectStatsTool extends McpTool {
    static metadata = {
        name: 'project_stats',
        description: 'Get detailed statistics for a specific project in a channel',
        inputSchema: z.object({
            channelId: z.string().describe('Channel ID to query'),
            projectId: z.string().optional().describe('Optional project ID (defaults to "default")'),
            includeResources: z.boolean().optional().default(false).describe('Include resource-level details')
        })
    };

    static async execute(mm, args) {
        const { channelId, projectId = 'default', includeResources } = args;

        // Validate channel exists
        if (!mm.rm.channelIds.includes(channelId)) {
            throw new McpInputError(`Channel "${channelId}" not found`, {
                hints: [`Available channels: ${mm.rm.channelIds.join(', ')}`]
            });
        }

        // Get channel statistics
        const channelStats = await mm.rm.getActiveContentStats(channelId);
        const projectStats = channelStats.find(s => (s.prj ?? 'default') === projectId);

        if (!projectStats) {
            throw new McpInputError(`Project "${projectId}" not found in channel "${channelId}"`, {
                hints: ['Use the status tool to see available projects']
            });
        }

        // Build response
        const result = {
            channelId,
            projectId,
            sourceLang: projectStats.sourceLang,
            targetLangs: projectStats.targetLangs || [],
            segmentCount: projectStats.segmentCount,
            resourceCount: projectStats.resCount,
            lastModified: projectStats.lastModified
        };

        // Optionally include resource details
        if (includeResources) {
            const channel = mm.rm.getChannel(channelId);
            const resources = await channel.getActiveContent();
            const projectResources = resources.filter(r => (r.prj ?? 'default') === projectId);
            
            result.resources = projectResources.map(r => ({
                resourceId: r.rid,
                segmentCount: r.segments?.length || 0,
                lastModified: r.lastModified
            }));
        }

        return result;
    }
}

/**
 * Example custom tool that provides translation quality insights
 */
export class QualityInsightsTool extends McpTool {
    static metadata = {
        name: 'quality_insights',
        description: 'Analyze translation quality distribution for a language pair',
        inputSchema: z.object({
            sourceLang: z.string().describe('Source language code'),
            targetLang: z.string().describe('Target language code'),
            provider: z.string().optional().describe('Optional: filter by translation provider')
        })
    };

    static async execute(mm, args) {
        const { sourceLang, targetLang, provider } = args;

        // Get TM for language pair
        const tm = mm.tmm.getTM(sourceLang, targetLang);
        const stats = await tm.getStats();

        // Filter by provider if specified
        const filteredStats = provider
            ? stats.filter(s => s.translationProvider === provider)
            : stats;

        if (filteredStats.length === 0) {
            return {
                sourceLang,
                targetLang,
                provider: provider || 'all',
                message: 'No translation data found for this language pair'
            };
        }

        // Calculate quality distribution
        const totalTUs = filteredStats.reduce((sum, s) => sum + s.tuCount, 0);
        const byProvider = {};

        for (const stat of filteredStats) {
            byProvider[stat.translationProvider] = {
                translationUnits: stat.tuCount,
                jobs: stat.jobCount,
                status: stat.status,
                percentage: ((stat.tuCount / totalTUs) * 100).toFixed(2)
            };
        }

        return {
            sourceLang,
            targetLang,
            totalTranslationUnits: totalTUs,
            providerBreakdown: byProvider,
            uniqueProviders: Object.keys(byProvider).length
        };
    }
}

// Example usage in l10nmonster.config.mjs:
/*
import config from '@l10nmonster/core';
import serve from '@l10nmonster/server';
import { createMcpRoutes, registerTool } from '@l10nmonster/mcp';
import { ProjectStatsTool, QualityInsightsTool } from './custom-mcp-tools.js';

// Register custom MCP tools
registerTool(ProjectStatsTool);
registerTool(QualityInsightsTool);

// Register MCP routes with the server
serve.registerExtension('mcp', createMcpRoutes);

export default config.l10nMonster(import.meta.dirname)
    .action(serve);
*/

