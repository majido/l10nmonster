import * as path from 'path';
import {
    existsSync,
    unlinkSync,
    statSync,
    readFileSync,
    mkdirSync,
    writeFileSync,
} from 'fs';
import { globbySync } from 'globby';

export class FsSource {
    constructor({ baseDir, globs, filter, targetLangs, prj, resDecorator }) {
        if (globs === undefined) {
            throw 'a globs property is required in FsSource';
        } else {
            this.globs = globs;
            this.filter = filter;
            this.targetLangs = targetLangs;
            this.prj = prj;
            this.resDecorator = resDecorator;
            this.baseDir = baseDir ? path.join(this.ctx.baseDir, baseDir) : this.ctx.baseDir;
        }
    }

    async fetchResourceStats() {
        const resources = [];
        const expandedFileNames = globbySync(this.globs.map(g => path.join(this.baseDir, g)));
        this.ctx.logger.info(`Fetched fs globs: ${this.globs}`);
        for (const fileName of expandedFileNames) {
            const id = path.relative(this.baseDir, fileName);
            if (!this.filter || this.filter(id)) {
                const stats = statSync(fileName);
                let resMeta = {
                    id,
                    modified: this.ctx.regression ? 1 : stats.mtime.toISOString(),
                };
                this.targetLangs && (resMeta.targetLangs = this.targetLangs);
                this.prj && (resMeta.prj = this.prj);
                if (typeof this.resDecorator === 'function') {
                    resMeta = this.resDecorator(resMeta);
                }
                resources.push(resMeta);
            }
        }
        return resources;
    }

    async fetchResource(resourceId) {
        return readFileSync(path.resolve(this.baseDir, resourceId), 'utf8');
    }
}

export class FsTarget {
    constructor({ baseDir, targetPath, deleteEmpty }) {
        this.targetPath = targetPath;
        this.deleteEmpty = deleteEmpty;
        this.baseDir = baseDir ? path.join(this.ctx.baseDir, baseDir) : this.ctx.baseDir;
    }

    translatedResourceId(lang, resourceId) {
        return path.resolve(this.baseDir, this.targetPath(lang, resourceId));
    }

    async fetchTranslatedResource(lang, resourceId) {
        return readFileSync(this.translatedResourceId(lang, resourceId), 'utf8');
    }

    async commitTranslatedResource(lang, resourceId, translatedRes) {
        const translatedPath = path.resolve(this.baseDir, this.targetPath(lang, resourceId));
        if (translatedRes === null) {
            this.deleteEmpty && existsSync(translatedPath) && unlinkSync(translatedPath);
        } else {
            await mkdirSync(path.dirname(translatedPath), {recursive: true});
            writeFileSync(translatedPath, translatedRes, 'utf8');
        }
    }
}
