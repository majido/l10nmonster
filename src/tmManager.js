import * as path from 'path';
import {
    existsSync,
    readFileSync,
    writeFileSync,
} from 'fs';
import { flattenNormalizedSourceToOrdinal, cleanupTU } from './normalizers/util.js';
import { targetTUWhitelist, refreshedFromSource } from './schemas.js';

class TM {
    constructor(sourceLang, targetLang, tmPathName, logger, configSeal, jobs, srcGuidMap) {
        const EMPTY_TM = {
            sourceLang,
            targetLang,
            configSeal,
            jobStatus: {},
            tus: {},
        };
        this.tmPathName = tmPathName;
        this.logger = logger;
        if (existsSync(tmPathName)) {
            this.tm = JSON.parse(readFileSync(tmPathName, 'utf8'));
            const jobMap = Object.fromEntries(jobs);
            const extraJobs = Object.keys(this.tm?.jobStatus ?? {}).filter(jobGuid => !jobMap[jobGuid]);
            // nuke the cache if config seal is broken or jobs were removed
            if (!(this.tm?.configSeal === configSeal) || extraJobs.length > 0) {
                this.tm = EMPTY_TM;
                logger.info(`Nuking existing TM ${tmPathName}`);
            }
        } else {
            this.tm = EMPTY_TM;
        }
        this.lookUpByFlattenSrc = {};
        Object.values(this.tm.tus).forEach(tu => this.setEntryByGuid(tu.guid, tu)); // this is to generate side-effects
        this.srcGuidMap = srcGuidMap;
    }

    get guids() {
        return Object.keys(this.tm.tus);
    }

    getEntryByGuid(guid) {
        return this.tm.tus[guid];
    }

    setEntryByGuid(guid, entry) {
        // const getSpurious = (tu, whitelist) => Object.entries(tu)
        //     .filter(e => !whitelist.has(e[0]))
        //     .map(e => e[0])
        //     .join(', ');
        // const spurious = getSpurious(entry, targetTUWhitelist);
        // spurious && console.error(spurious);
        if (!entry.guid || !Number.isInteger(entry.q) || ((!Number.isInteger(entry.ts) || !(typeof entry.tgt === 'string' || entry.ntgt)) && !entry.inflight)) {
            throw `cannot set TM entry missing mandatory field: ${JSON.stringify(entry)}`;
        }
        const cleanedTU = cleanupTU(entry, targetTUWhitelist);
        this.tm.tus[guid] = cleanedTU;
        const flattenSrc = cleanedTU.nsrc ? flattenNormalizedSourceToOrdinal(cleanedTU.nsrc) : cleanedTU.src;
        this.lookUpByFlattenSrc[flattenSrc] ??= [];
        !this.lookUpByFlattenSrc[flattenSrc].includes(cleanedTU) && this.lookUpByFlattenSrc[flattenSrc].push(cleanedTU);
    }

    getAllEntriesBySrc(src) {
        const flattenSrc = Array.isArray(src) ? flattenNormalizedSourceToOrdinal(src) : src;
        return this.lookUpByFlattenSrc[flattenSrc] || [];
    }

    getJobStatus(jobGuid) {
        return this.tm.jobStatus[jobGuid];
    }

    setJobStatus(jobGuid, status, mtime) {
        this.tm.jobStatus[jobGuid] = { status, mtime };
    }

    async commit() {
        this.logger.info(`Updating ${this.tmPathName}...`);
        writeFileSync(this.tmPathName, JSON.stringify(this.tm, null, '\t'), 'utf8');
    }

    async processJob(jobResponse, jobRequest, mtime) {
        const requestedUnits = {};
        jobRequest?.tus && jobRequest.tus.forEach(tu => requestedUnits[tu.guid] = tu);
        const { jobGuid, status, inflight, tus } = jobResponse;
        if (inflight) {
            for (const guid of inflight) {
                const reqEntry = requestedUnits[guid] ?? {};
                const tmEntry = this.getEntryByGuid(guid);
                if (!tmEntry) {
                    this.setEntryByGuid(guid, { ...reqEntry, ts: jobResponse.ts, q: 0, jobGuid, inflight: true });
                }
            }
        }
        if (tus) {
            for (const tu of tus) {
                const tmEntry = this.getEntryByGuid(tu.guid);
                const reqEntry = requestedUnits[tu.guid] ?? {};
                const srcEntry = Object.fromEntries(Object.entries(this.srcGuidMap[tu.guid] ?? {}).filter(p => refreshedFromSource.has(p[0])));
                const rectifiedTU = { ...reqEntry, ts: jobResponse.ts, ...tu, jobGuid, ...srcEntry };
                if (!tmEntry || tmEntry.q < tu.q || (tmEntry.q === tu.q && tmEntry.ts < rectifiedTU.ts)) {
                    this.setEntryByGuid(tu.guid, rectifiedTU);
                }
            }
        }
        this.setJobStatus(jobGuid, status, mtime);
    }
}

export default class TMManager {
    constructor({ monsterDir, jobStore, sourceMgr, ctx, configSeal }) {
        this.monsterDir = monsterDir;
        this.jobStore = jobStore;
        this.sourceMgr = sourceMgr;
        this.ctx = ctx;
        this.configSeal = configSeal;
        this.tmCache = {};
        this.generation = new Date().getTime();
    }

    async getTM(sourceLang, targetLang) {
        let dirty = false;
        const tmFileName = `tmCache_${sourceLang}_${targetLang}.json`;
        let tm = this.tmCache[tmFileName];
        if (!tm) {
            !this.srcGuidMap && (this.srcGuidMap = await this.sourceMgr.getGuidMap());
            const jobs = (await this.jobStore.getJobStatusByLangPair(sourceLang, targetLang))
                .filter(e => [ 'pending', 'done' ].includes(e[1].status));
            tm = new TM(sourceLang, targetLang, path.join(this.monsterDir, tmFileName), this.ctx.logger, this.configSeal, jobs, this.srcGuidMap);
            this.tmCache[tmFileName] = tm;
            for (const [jobGuid, jobStat] of jobs) {
                const jobInTM = tm.getJobStatus(jobGuid);
                if (!(jobInTM?.status === jobStat.status) || !(jobInTM?.mtime === jobStat.mtime)) {
                    this.ctx.logger.info(`Applying job ${jobGuid} to the ${sourceLang} -> ${targetLang} TM...`);
                    const jobResponse = await this.jobStore.getJob(jobGuid);
                    const jobRequest = await this.jobStore.getJobRequest(jobGuid);
                    await tm.processJob(jobResponse, jobRequest, jobStat.mtime);
                    dirty = true;
                }
            }
            dirty && (await tm.commit());
        }
        return tm;
    }
}
