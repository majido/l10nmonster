export async function pullCmd(mm, { limitToLang }) {
    const stats = { numPendingJobs: 0, translatedStrings: 0 };
    const targetLangs = mm.getTargetLangs(limitToLang);
    for (const targetLang of targetLangs) {
        const pendingJobs = (await mm.jobStore.getJobStatusByLangPair(mm.sourceLang, targetLang))
            .filter(e => e[1] === 'pending')
            .map(e => e[0]);
        stats.numPendingJobs += pendingJobs.length;
        for (const jobGuid of pendingJobs) {
            const jobRequest = await mm.jobStore.getJobRequest(jobGuid);
            const pendingJob = await mm.jobStore.getJob(jobGuid);
            if (pendingJob.status === 'pending') {
                mm.ctx.logger.info(`Pulling job ${jobGuid}...`);
                const translationProvider = mm.getTranslationProvider(pendingJob);
                const jobResponse = await translationProvider.translator.fetchTranslations(pendingJob, jobRequest);
                if (jobResponse?.status === 'done') {
                    await mm.processJob(jobResponse);
                    stats.translatedStrings += jobResponse.tus.length;
                } else if (jobResponse?.status === 'pending') {
                    mm.ctx.logger.info(`Got ${jobResponse.tus.length} translations from TOS for job ${jobRequest.jobGuid} but there are still ${jobResponse.inflight.length} translations in flight`);
                }
            }
        }
    }
    return stats;
}
