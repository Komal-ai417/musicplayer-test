#include <bits/stdc++.h>
using namespace std;

struct Operation {
    int type; // 1 or 2
    int k;    // only valid when type == 1
};

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int T;
    if (!(cin >> T)) return 0;
    for (int tc = 1; tc <= T; ++tc) {
        int N;
        cin >> N;
        vector<int> A(N);
        for (int i = 0; i < N; ++i) cin >> A[i];

        // Parse A into rows (length k, start value s)
        vector<pair<int,int>> rows; // {k, s}
        rows.reserve(N);
        for (int i = 0; i < N; ) {
            int s = A[i];
            if (s == 1) {
                int j = i;
                while (j + 1 < N && A[j + 1] == A[j] + 1) ++j;
                int k = A[j];
                rows.emplace_back(k, 1);
                i = j + 1;
            } else {
                int j = i;
                while (j + 1 < N && A[j + 1] == A[j] + 1) ++j;
                int k = A[j];
                // Expect wrap to 1 then continue to s-1
                if (j + 1 < N && A[j + 1] == 1) {
                    ++j; // now at first 1 after wrap
                    // Advance until we reach s-1 (end of this row)
                    while (j < N && A[j] != s - 1) ++j;
                    // Given problem guarantees, s-1 will be found
                } else {
                    // Given guarantees, this should not happen; but guard anyway
                    // Treat as minimal row (k = s) ending immediately
                }
                rows.emplace_back(k, s);
                i = j + 1;
            }
        }

        // Generate reverse operations:
        // Maintain total right-rotations applied so far (in reverse).
        vector<Operation> revOps;
        revOps.reserve(N); // M <= N
        long long totalRightRotations = 0;

        for (int idx = (int)rows.size() - 1; idx >= 0; --idx) {
            int k = rows[idx].first;
            int s = rows[idx].second; // initial first element of this row in final A

            // Effective first element after totalRightRotations:
            // Need d right-rotations so that first element becomes 1.
            // d = ((s-1) - (totalRightRotations mod k)) mod k, normalized to [0, k-1]
            int rmod = (int)(totalRightRotations % k);
            int d = ( ( (s - 1) - rmod ) % k + k ) % k;

            for (int t = 0; t < d; ++t) revOps.push_back({2, 0});
            totalRightRotations += d;

            revOps.push_back({1, k});
        }

        // Forward operations are the reverse of revOps
        cout << "Case #" << tc << ": " << (int)revOps.size() << '\n';
        for (int i = (int)revOps.size() - 1; i >= 0; --i) {
            if (revOps[i].type == 1) {
                cout << "1 " << revOps[i].k << '\n';
            } else {
                cout << "2\n";
            }
        }
    }
    return 0;
}
