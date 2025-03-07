import { TranslationServiceClient } from '@google-cloud/translate';

import {
    flattenNormalizedSourceToXmlV1, extractNormalizedPartsFromXmlV1,
    normalizedStringsAreEqual,
} from '../normalizers/util.js';

const MAX_CHUNK_SIZE = 1000;
const RECOMMENDED_LENGTH = 30000;

async function gctTranslateChunkOp({ keyFilename, request, offset }) {
    try {
        const gctClient = new TranslationServiceClient({ keyFilename });
        const [ response ] = await gctClient.translateText(request);
        const translations = {};
        response.translations.forEach((tx, idx) => {
            translations[idx + offset] = tx.translatedText;
        });
        return translations;
    } catch(error) {
        throw `GCT: ${error.toString()}`;
    }
}

async function gctMergeTranslatedChunksOp({ jobRequest, tuMeta, quality, ts }, chunks) {
    const { tus, ...jobResponse } = jobRequest;
    const translations = Object.assign({}, ...chunks);
    jobResponse.tus = tus.map((tu, idx) => {
        const translation = { guid: tu.guid };
        const gctTx = translations[idx] || {};
        const ntgt = extractNormalizedPartsFromXmlV1(gctTx, tuMeta[idx] || {});
        if (tu.nsrc) {
            translation.ntgt = ntgt;
        } else {
            translation.tgt = ntgt[0];
        }
        translation.q = quality;
        return translation;
    });
    jobResponse.status = 'done';
    jobResponse.ts = ts;
    return jobResponse;
}

export class GoogleCloudTranslateV3 {
    constructor({ keyFilename, projectId, location, quality, languageMapper }) {
        if ((keyFilename && projectId && quality) === undefined) {
            throw 'You must specify keyFilename, projectId, quality for GoogleCloudTranslateV3';
        } else {
            this.keyFilename = keyFilename;
            this.parent = `projects/${projectId}/locations/${location ?? 'global'}`
            this.quality = quality;
            this.languageMapper = languageMapper;
            this.ctx.opsMgr.registerOp(gctTranslateChunkOp, { idempotent: false });
            this.ctx.opsMgr.registerOp(gctMergeTranslatedChunksOp, { idempotent: true });
        }
    }

    async requestTranslations(jobRequest) {
        const sourceLanguageCode = (this.languageMapper && this.languageMapper(jobRequest.sourceLang)) ?? jobRequest.sourceLang;
        const targetLanguageCode = (this.languageMapper && this.languageMapper(jobRequest.targetLang)) ?? jobRequest.targetLang;
        const tuMeta = {};
        const gctPayload = jobRequest.tus.map((tu, idx) => {
            const [xmlSrc, phMap ] = flattenNormalizedSourceToXmlV1(tu.nsrc || [ tu.src ]);
            if (Object.keys(phMap).length > 0) {
                tuMeta[idx] = phMap;
            }
            return xmlSrc;
        });

        const requestTranslationsTask = this.ctx.opsMgr.createTask();
        try {
            const chunkOps = [];
            for (let currentIdx = 0; currentIdx < gctPayload.length;) {
                const offset = currentIdx;
                const contents = [];
                let currentTotalLength = 0;
                while (currentIdx < gctPayload.length && contents.length < MAX_CHUNK_SIZE && currentTotalLength < RECOMMENDED_LENGTH) {
                    currentTotalLength += gctPayload[currentIdx].length;
                    contents.push(gctPayload[currentIdx]);
                    currentIdx++;
                }
                this.ctx.logger.info(`Preparing GCT translate, offset: ${offset} chunk strings: ${contents.length} chunk char length: ${currentTotalLength}`);
                const translateOp = await requestTranslationsTask.enqueue(
                    gctTranslateChunkOp,
                    {
                        keyFilename: this.keyFilename,
                        request: {
                            parent: this.parent,
                            contents,
                            mimeType: 'text/html',
                            sourceLanguageCode,
                            targetLanguageCode,
                        },
                        offset,
                    }
                );
                chunkOps.push(translateOp);
            }
            const rootOp = await requestTranslationsTask.enqueue(
                gctMergeTranslatedChunksOp,
                {
                    jobRequest,
                    tuMeta,
                    quality: this.quality,
                    ts: this.ctx.regression ? 1 : new Date().getTime(),
                },
                chunkOps
            );
            return await requestTranslationsTask.execute(rootOp);
        } catch (error) {
            throw `GCT call failed - ${error}`;
        }
    }

    // sync api only for now
    async fetchTranslations() {
        return null;
    }

    async refreshTranslations(jobRequest) {
        const fullResponse = await this.requestTranslations(jobRequest);
        const reqTuMap = jobRequest.tus.reduce((p,c) => (p[c.guid] = c, p), {});
        return {
            ...fullResponse,
            tus: fullResponse.tus.filter(tu => !normalizedStringsAreEqual(reqTuMap[tu.guid].ntgt ?? reqTuMap[tu.guid].tgt, tu.ntgt ?? tu.tgt)),
        };
    }
}
