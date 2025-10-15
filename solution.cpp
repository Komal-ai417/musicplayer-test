#include <bits/stdc++.h>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  int T;
  if (!(cin >> T)) return 0;
  for (int tc = 1; tc <= T; ++tc) {
    int arrayLength;
    cin >> arrayLength;
    vector<int> inputArray(arrayLength);
    for (int i = 0; i < arrayLength; ++i) cin >> inputArray[i];

    // 1) Partition A into blocks that are rotated identities.
    //    For a block starting at value s:
    //      - If s == 1: it's [1,2,...,k] (no wrap), k = last value of the increasing run.
    //      - If s > 1: it's [s, s+1, ..., k, 1, 2, ..., s-1], where the first time we see 1
    //                  occurs right after reaching k.
    vector<int> blockLengths; // k_i
    vector<int> blockShifts;  // r_i = s_i - 1
    int currentIndex = 0;
    while (currentIndex < arrayLength) {
      int blockStartValue = inputArray[currentIndex];
      int blockEndIndex = currentIndex;

      // Extend strictly increasing by +1
      while (blockEndIndex + 1 < arrayLength &&
             inputArray[blockEndIndex + 1] == inputArray[blockEndIndex] + 1) {
        ++blockEndIndex;
      }

      if (blockStartValue == 1) {
        // Block is [1,2,...,k]
        int k = inputArray[blockEndIndex];
        blockLengths.push_back(k);
        blockShifts.push_back(0);
        currentIndex = blockEndIndex + 1;
      } else {
        // Block is [s, s+1, ..., k, 1, 2, ..., s-1]
        int k = inputArray[blockEndIndex];
        // Include the '1'
        ++blockEndIndex; // now at the '1'
        // Consume 2..s-1 (s-1 elements total including the '1' we just included)
        // We rely on the problem guarantee; bounds/values are valid.
        blockEndIndex += (blockStartValue - 1) - 1; // we already included '1', so add (s-2) more
        blockLengths.push_back(k);
        blockShifts.push_back(blockStartValue - 1);
        currentIndex = blockEndIndex + 1;
      }
    }

    // 2) Compute rotations-after-insertion t_i backwards:
    //    t_m = r_m; t_i = smallest >= t_{i+1} with t_i ≡ r_i (mod k_i)
    int blockCount = (int)blockLengths.size();
    vector<long long> rotationsAfterInsertion(blockCount, 0);
    rotationsAfterInsertion[blockCount - 1] = blockShifts.back();
    for (int i = blockCount - 2; i >= 0; --i) {
      long long r = blockShifts[i];
      long long k = blockLengths[i];
      long long nextT = rotationsAfterInsertion[i + 1];
      if (r >= nextT) {
        rotationsAfterInsertion[i] = r;
      } else {
        long long need = nextT - r;
        long long hops = (need + k - 1) / k; // ceil(need/k)
        rotationsAfterInsertion[i] = r + hops * k;
      }
    }

    // 3) Emit operations:
    //    For i in [0..m-2]: output "1 k_i", then (t_i - t_{i+1}) times "2".
    //    Then output "1 k_m", followed by t_m times "2".
    vector<pair<int,int>> ops; // {type, k} where type 1 => (1,k), type 2 => (2,0)
    for (int i = 0; i + 1 < blockCount; ++i) {
      ops.push_back({1, blockLengths[i]});
      long long diff = rotationsAfterInsertion[i] - rotationsAfterInsertion[i + 1];
      for (long long d = 0; d < diff; ++d) ops.push_back({2, 0});
    }
    // Last block
    ops.push_back({1, blockLengths.back()});
    for (long long d = 0; d < rotationsAfterInsertion.back(); ++d) ops.push_back({2, 0});

    cout << "Case #" << tc << ": " << ops.size() << "\n";
    for (auto const& p : ops) {
        int type = p.first;
        int k = p.second;

        if (type == 1)
            cout << "1 " << k << "\n";
        else
            cout << "2\n";
    }
  }

  return 0;
}
