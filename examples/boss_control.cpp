struct BossInfo {
    int bossId;
    int status;
    int enable;
    int alarm;
};

int FindBossStatus(const BossInfo bossInfo[], int bossCount, int targetId) {
    for (int i = 0; i < bossCount; ++i) {
        if (bossInfo[i].bossId == targetId) {
            return bossInfo[i].status;
        }
    }
    return -1;
}
