#include <bits/stdc++.h>
using namespace std;

vector<int> flatten(const vector<vector<int>>& B) {
    vector<int> result;
    for (const auto& perm : B) {
        for (int val : perm) {
            result.push_back(val);
        }
    }
    return result;
}

int main() {
    int T;
    cin >> T;
    
    for (int tc = 1; tc <= T; tc++) {
        int N;
        cin >> N;
        vector<int> A(N);
        for (int i = 0; i < N; i++) {
            cin >> A[i];
        }
        
        vector<string> ops;
        vector<vector<int>> B;
        
        int pos = 0;
        while (pos < N) {
            int best_len = -1, best_rot_before = 0, best_rot_after = 0;
            size_t best_new_pos = pos;
            
            // Try rotating before adding (if B is not empty)
            if (!B.empty()) {
                for (int rot_before = 1; rot_before <= N; rot_before++) {
                    vector<vector<int>> test_B = B;
                    // Apply rot_before rotations
                    for (int r = 0; r < rot_before; r++) {
                        for (auto& p : test_B) {
                            rotate(p.begin(), p.begin() + 1, p.end());
                        }
                    }
                    
                    // Now try adding a permutation
                    for (int len = 1; len <= N; len++) {
                        for (int rot_after = 0; rot_after <= len; rot_after++) {
                            vector<vector<int>> test_B2 = test_B;
                            vector<int> new_perm(len);
                            for (int i = 0; i < len; i++) {
                                new_perm[i] = i + 1;
                            }
                            test_B2.push_back(new_perm);
                            
                            // Apply rot_after rotations
                            for (int r = 0; r < rot_after; r++) {
                                for (auto& p : test_B2) {
                                    rotate(p.begin(), p.begin() + 1, p.end());
                                }
                            }
                            
                            vector<int> flattened = flatten(test_B2);
                            if (flattened.size() <= (size_t)N) {
                                bool matches = true;
                                for (size_t i = 0; i < flattened.size(); i++) {
                                    if (flattened[i] != A[i]) {
                                        matches = false;
                                        break;
                                    }
                                }
                                
                                if (matches && flattened.size() > best_new_pos) {
                                    best_len = len;
                                    best_rot_before = rot_before;
                                    best_rot_after = rot_after;
                                    best_new_pos = flattened.size();
                                }
                            }
                        }
                    }
                }
            }
            
            // Also try without rotating before
            for (int len = 1; len <= N; len++) {
                for (int rot_after = 0; rot_after <= len; rot_after++) {
                    vector<vector<int>> test_B = B;
                    vector<int> new_perm(len);
                    for (int i = 0; i < len; i++) {
                        new_perm[i] = i + 1;
                    }
                    test_B.push_back(new_perm);
                    
                    for (int r = 0; r < rot_after; r++) {
                        for (auto& p : test_B) {
                            rotate(p.begin(), p.begin() + 1, p.end());
                        }
                    }
                    
                    vector<int> flattened = flatten(test_B);
                    if (flattened.size() <= (size_t)N) {
                        bool matches = true;
                        for (size_t i = 0; i < flattened.size(); i++) {
                            if (flattened[i] != A[i]) {
                                matches = false;
                                break;
                            }
                        }
                        
                        int total_ops = 1 + rot_after;
                        int best_total_ops = (best_len >= 0) ? (1 + best_rot_before + best_rot_after) : INT_MAX;
                        
                        if (matches && flattened.size() > best_new_pos) {
                            best_len = len;
                            best_rot_before = 0;
                            best_rot_after = rot_after;
                            best_new_pos = flattened.size();
                        } else if (matches && flattened.size() == best_new_pos && total_ops < best_total_ops) {
                            // Prefer fewer operations
                            best_len = len;
                            best_rot_before = 0;
                            best_rot_after = rot_after;
                            best_new_pos = flattened.size();
                        }
                    }
                }
            }
            
            if (best_new_pos > (size_t)pos) {
                // Apply rotations before
                for (int r = 0; r < best_rot_before; r++) {
                    ops.push_back("2");
                    for (auto& p : B) {
                        rotate(p.begin(), p.begin() + 1, p.end());
                    }
                }
                
                // Add permutation
                ops.push_back("1 " + to_string(best_len));
                vector<int> new_perm(best_len);
                for (int i = 0; i < best_len; i++) {
                    new_perm[i] = i + 1;
                }
                B.push_back(new_perm);
                
                // Apply rotations after
                for (int r = 0; r < best_rot_after; r++) {
                    ops.push_back("2");
                    for (auto& p : B) {
                        rotate(p.begin(), p.begin() + 1, p.end());
                    }
                }
                
                pos = (int)best_new_pos;
            } else {
                break;
            }
        }
        
        cout << "Case #" << tc << ": " << ops.size() << "\n";
        for (const auto& op : ops) {
            cout << op << "\n";
        }
    }
    
    return 0;
}
