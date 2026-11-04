#include <bits/stdc++.h>
using namespace std;

bool isValidPermutation(vector<int>& A, int start, int len) {
    if (start + len > A.size()) return false;
    vector<bool> seen(len + 1, false);
    for (int i = start; i < start + len; i++) {
        if (A[i] < 1 || A[i] > len) return false;
        if (seen[A[i]]) return false;
        seen[A[i]] = true;
    }
    return true;
}

int getRotation(vector<int>& A, int start, int len) {
    return A[start] - 1;
}

bool parsePermutations(vector<int>& A, int pos, vector<pair<int, int>>& perms) {
    if (pos == A.size()) {
        return true;
    }
    
    // Try different lengths
    for (int len = 1; len <= A.size() - pos; len++) {
        if (isValidPermutation(A, pos, len)) {
            int rot = getRotation(A, pos, len);
            perms.push_back({len, rot});
            if (parsePermutations(A, pos + len, perms)) {
                return true;
            }
            perms.pop_back();
        }
    }
    
    return false;
}

void solve(int caseNum) {
    int N;
    cin >> N;
    vector<int> A(N);
    for (int i = 0; i < N; i++) {
        cin >> A[i];
    }
    
    // Parse A into permutations using backtracking
    vector<pair<int, int>> perms; // (length, rotation)
    parsePermutations(A, 0, perms);
    
    // Generate operations
    vector<pair<int, int>> ops; // (type, value)
    
    for (int i = 0; i < perms.size(); i++) {
        int len = perms[i].first;
        int rot = perms[i].second;
        
        // Add this permutation
        ops.push_back({1, len});
        
        // Calculate rotations to do after adding this permutation
        int nextRot = (i + 1 < perms.size()) ? perms[i + 1].second : 0;
        int rotations = rot - nextRot;
        
        // If rotations is negative, add multiples of len to make it non-negative
        while (rotations < 0) {
            rotations += len;
        }
        
        // Perform the rotations
        for (int j = 0; j < rotations; j++) {
            ops.push_back({2, 0});
        }
    }
    
    cout << "Case #" << caseNum << ": " << ops.size() << "\n";
    for (auto op : ops) {
        if (op.first == 1) {
            cout << "1 " << op.second << "\n";
        } else {
            cout << "2\n";
        }
    }
}

int main() {
    int T;
    cin >> T;
    for (int i = 1; i <= T; i++) {
        solve(i);
    }
    return 0;
}
