#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 863e49066ca4d61c9adfe62aca3bf21b90e1af8c
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -e .
git checkout 863e49066ca4d61c9adfe62aca3bf21b90e1af8c xarray/tests/test_combine.py xarray/tests/test_concat.py
git apply -v - <<'EOF_114329324912'
diff --git a/xarray/tests/test_combine.py b/xarray/tests/test_combine.py
--- a/xarray/tests/test_combine.py
+++ b/xarray/tests/test_combine.py
@@ -782,12 +782,11 @@ def test_auto_combine_previously_failed(self):
         actual = auto_combine(datasets, concat_dim="t")
         assert_identical(expected, actual)
 
-    def test_auto_combine_still_fails(self):
-        # concat can't handle new variables (yet):
-        # https://github.com/pydata/xarray/issues/508
+    def test_auto_combine_with_new_variables(self):
         datasets = [Dataset({"x": 0}, {"y": 0}), Dataset({"x": 1}, {"y": 1, "z": 1})]
-        with pytest.raises(ValueError):
-            auto_combine(datasets, "y")
+        actual = auto_combine(datasets, "y")
+        expected = Dataset({"x": ("y", [0, 1])}, {"y": [0, 1], "z": 1})
+        assert_identical(expected, actual)
 
     def test_auto_combine_no_concat(self):
         objs = [Dataset({"x": 0}), Dataset({"y": 1})]
diff --git a/xarray/tests/test_concat.py b/xarray/tests/test_concat.py
--- a/xarray/tests/test_concat.py
+++ b/xarray/tests/test_concat.py
@@ -68,6 +68,22 @@ def test_concat_simple(self, data, dim, coords):
         datasets = [g for _, g in data.groupby(dim, squeeze=False)]
         assert_identical(data, concat(datasets, dim, coords=coords))
 
+    def test_concat_merge_variables_present_in_some_datasets(self, data):
+        # coordinates present in some datasets but not others
+        ds1 = Dataset(data_vars={"a": ("y", [0.1])}, coords={"x": 0.1})
+        ds2 = Dataset(data_vars={"a": ("y", [0.2])}, coords={"z": 0.2})
+        actual = concat([ds1, ds2], dim="y", coords="minimal")
+        expected = Dataset({"a": ("y", [0.1, 0.2])}, coords={"x": 0.1, "z": 0.2})
+        assert_identical(expected, actual)
+
+        # data variables present in some datasets but not others
+        split_data = [data.isel(dim1=slice(3)), data.isel(dim1=slice(3, None))]
+        data0, data1 = deepcopy(split_data)
+        data1["foo"] = ("bar", np.random.randn(10))
+        actual = concat([data0, data1], "dim1")
+        expected = data.copy().assign(foo=data1.foo)
+        assert_identical(expected, actual)
+
     def test_concat_2(self, data):
         dim = "dim2"
         datasets = [g for _, g in data.groupby(dim, squeeze=True)]
@@ -190,11 +206,6 @@ def test_concat_errors(self):
             concat([data0, data1], "dim1", compat="identical")
         assert_identical(data, concat([data0, data1], "dim1", compat="equals"))
 
-        with raises_regex(ValueError, "present in some datasets"):
-            data0, data1 = deepcopy(split_data)
-            data1["foo"] = ("bar", np.random.randn(10))
-            concat([data0, data1], "dim1")
-
         with raises_regex(ValueError, "compat.* invalid"):
             concat(split_data, "dim1", compat="foobar")
 

EOF_114329324912
: '>>>>> Start Test Output'
pytest -rA xarray/tests/test_combine.py xarray/tests/test_concat.py
: '>>>>> End Test Output'
git checkout 863e49066ca4d61c9adfe62aca3bf21b90e1af8c xarray/tests/test_combine.py xarray/tests/test_concat.py
