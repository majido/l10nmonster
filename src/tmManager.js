import * as path from 'path';
import {
    existsSync,
    readFileSync,
} from 'fs';
import * as fs from 'fs/promises';
import {js2tmx} from 'tmexchange';
import { flattenNormalizedSourceToOrdinal, flattenNormalizedSourceV1 } from '../normalizers/util.js';

class TM {
    dirty = false;
    constructor(sourceLang, targetLang, tmPathName) {
        this.tmPathName = tmPathName;
        this.tm = existsSync(this.tmPathName) ?
            JSON.parse(readFileSync(this.tmPathName, 'utf8')) :
            {
                sourceLang,
                targetLang,
                jobStatus: {},
                tus: {},
            }
        ;
        this.lookUpByFlattenSrc = {};
        Object.values(this.tm.tus).forEach(tu => this.setEntryByGuid(tu.guid, tu)); // this is to generate side-effects
    }

    get size() {
        return Object.keys(this.tm.tus).length;
    }

    getEntryByGuid(guid) {
        return this.tm.tus[guid];
    }

    setEntryByGuid(guid, entry) {
        (this.dirty = (this.tm.tus[guid] !== entry)) && (this.tm.tus[guid] = entry); // only updates if different
        const flattenSrc = entry.nsrc ? flattenNormalizedSourceToOrdinal(entry.nsrc) : entry.src;
        this.lookUpByFlattenSrc[flattenSrc] ??= [];
        !this.lookUpByFlattenSrc[flattenSrc].includes(entry) && this.lookUpByFlattenSrc[flattenSrc].push(entry);
    }

    getAllEntriesBySrc(src) {
        const flattenSrc = Array.isArray(src) ? flattenNormalizedSourceToOrdinal(src) : src;
        return this.lookUpByFlattenSrc[flattenSrc] || [];
    }

    getJobStatus(jobId) {
        return this.tm.jobStatus[jobId];
    }

    setJobStatus(jobId, status) {
        if (this.tm.jobStatus[jobId] !== status) {
            this.tm.jobStatus[jobId] = status;
            this.dirty = true;
        }
    }

    async commit() {
        if (this.dirty) {
            this.verbose && console.log(`Updating ${this.tmPathName}...`);
            await fs.writeFile(this.tmPathName, JSON.stringify(this.tm, null, '\t'), 'utf8');
            this.dirty = false;
        }
    }

    async processJob(jobResponse, jobRequest) {
        const requestedUnits = (jobRequest?.tus ?? []).reduce((p,c) => (p[c.guid] = c, p), {});
        const { jobId, status, inflight, tus } = jobResponse;
        if (inflight) {
            for (const guid of inflight) {
                const reqEntry = requestedUnits[guid] ?? {};
                const tmEntry = this.getEntryByGuid(guid);
                if (!tmEntry) {
                    this.setEntryByGuid(guid, { ...reqEntry, q: 0, jobId, inflight: true });
                }
            }
        }
        if (tus) {
            for (const tu of tus) {
                const tmEntry = this.getEntryByGuid(tu.guid);
                const reqEntry = requestedUnits[tu.guid] ?? {};

                // this is convoluted because tmEntry.ts may be undefined
                // also note that this may result in non-deterministic behavior (equal ts means later one wins)
                const isNewish = !(tmEntry?.ts <= tu.ts);
                if (!tmEntry || tmEntry.q < tu.q || (tmEntry.q === tu.q && isNewish)) {
                    this.setEntryByGuid(tu.guid, { ...reqEntry, ...tu, jobId });
                }
            }
        }
        this.setJobStatus(jobId, status);
        await this.commit();
    }

    async exportTMX(sourceLookup, all) {
        const getMangledSrc = tu => (tu.nsrc ? flattenNormalizedSourceV1(tu.nsrc)[0] : tu.src);
        const getMangledTgt = tu => (tu.ntgt ? flattenNormalizedSourceV1(tu.ntgt)[0] : tu.tgt);
        const tmx = {
            sourceLanguage: this.tm.sourceLang,
            resources: {},
        };
        for (const tu of Object.values(sourceLookup)) {
            const translatedTU = this.tm.tus[tu.guid];
            const mangledTgt = translatedTU !== undefined && getMangledTgt(translatedTU);
            if (all || Boolean(mangledTgt)) {
                const group = tu.prj || 'default';
                tmx.resources[group] ??= {};
                tmx.resources[group][tu.guid] = {};
                tmx.resources[group][tu.guid][this.tm.sourceLang] = getMangledSrc(tu);
                Boolean(mangledTgt) && (tmx.resources[group][tu.guid][this.tm.targetLang] = mangledTgt);
            }
        }
        return [ tmx, await js2tmx(tmx) ];
    }
}

export default class TMManager {
    constructor({ monsterDir, jobStore }) {
        this.monsterDir = monsterDir;
        this.jobStore = jobStore;
        this.tmCache = {};
        this.generation = new Date().getTime();
    }

    async getTM(sourceLang, targetLang) {
        const tmFileName = `tmCache_${sourceLang}_${targetLang}.json`;
        let tm = this.tmCache[tmFileName];
        if (!tm) {
            TM.prototype.verbose = this.verbose;
            tm = new TM(sourceLang, targetLang, path.join(this.monsterDir, tmFileName));
            this.tmCache[tmFileName] = tm;
        }
        if (tm.generation !== this.generation) {
            tm.generation = this.generation;
            const jobs = await this.jobStore.getJobStatusByLangPair(sourceLang, targetLang);
            for (const [jobId, status] of jobs) {
                if (tm.getJobStatus(jobId) !== status) {
                    const job = await this.jobStore.getJob(jobId);
                    await tm.processJob(job);
                }
            }
        }
        return tm;
    }
}
