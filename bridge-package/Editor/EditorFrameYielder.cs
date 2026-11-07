using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using NUnit.Framework.Interfaces;
using UnityEngine;
using UnityEngine.TestTools;

namespace VsCodeTests
{
    /// <summary>
    /// Gives the Editor a frame before each test, so a run doesn't hold the main thread for a whole class.
    /// </summary>
    /// <remarks>
    /// The Test Framework only reads per-test actions from attributes, which would mean editing every test
    /// class, so this fills its private action cache instead. If a version doesn't have that cache, nothing
    /// is installed and tests run as usual.
    /// </remarks>
    internal static class EditorFrameYielder
    {
        private const string CommandType = "UnityEngine.TestTools.OuterUnityTestActionCommand";
        private const string CacheField = "m_TestActionsCache";
        private const string SetUpFixtureAttribute = "SetUpFixtureAttribute";

        private static readonly HashSet<string> TestAttributes = new HashSet<string>
        {
            "TestAttribute", "TestCaseAttribute", "TestCaseSourceAttribute", "UnityTestAttribute", "TheoryAttribute",
        };

        private const double MaxBreathingMs = 100;

        private static readonly System.Diagnostics.Stopwatch Clock = System.Diagnostics.Stopwatch.StartNew();
        private static readonly List<MethodInfo> Installed = new List<MethodInfo>();
        private static double workEndedAtMs;

        private sealed class YieldAction : IOuterUnityTestAction
        {
            public IEnumerator BeforeTest(ITest test)
            {
                // Always at least one frame. Slower work earns the Editor more time, up to the cap.
                double breathingMs = Math.Min(Clock.Elapsed.TotalMilliseconds - workEndedAtMs, MaxBreathingMs);
                double start = Clock.Elapsed.TotalMilliseconds;
                do
                {
                    yield return null;
                }
                while (Clock.Elapsed.TotalMilliseconds - start < breathingMs);

                workEndedAtMs = Clock.Elapsed.TotalMilliseconds;
            }

            public IEnumerator AfterTest(ITest test)
            {
                yield break;
            }
        }

        public static void Install()
        {
            Remove();
            Dictionary<MethodInfo, List<IOuterUnityTestAction>> cache = FindCache();
            if (cache == null) return;

            try
            {
                bool readsClassActions = ReadsClassActions();
                foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (ReferencesNUnit(assembly)) InstallInAssembly(assembly, cache, readsClassActions);
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[VsCodeTests] Tests will run without Editor frames: {e.Message}");
                Remove();
            }
        }

        public static void Remove()
        {
            Dictionary<MethodInfo, List<IOuterUnityTestAction>> cache = FindCache();
            if (cache != null)
            {
                foreach (MethodInfo method in Installed) cache.Remove(method);
            }
            Installed.Clear();
        }

        private static Dictionary<MethodInfo, List<IOuterUnityTestAction>> FindCache()
        {
            FieldInfo field = typeof(IOuterUnityTestAction).Assembly.GetType(CommandType)
                ?.GetField(CacheField, BindingFlags.NonPublic | BindingFlags.Static);
            return field?.GetValue(null) as Dictionary<MethodInfo, List<IOuterUnityTestAction>>;
        }

        private static bool ReferencesNUnit(Assembly assembly)
        {
            return !assembly.IsDynamic && Array.Exists(assembly.GetReferencedAssemblies(), a => a.Name == "nunit.framework");
        }

        private static void InstallInAssembly(Assembly assembly, Dictionary<MethodInfo, List<IOuterUnityTestAction>> cache, bool readsClassActions)
        {
            Type[] types;
            try
            {
                types = assembly.GetTypes();
            }
            catch (ReflectionTypeLoadException)
            {
                return;
            }

            // Actions on a [SetUpFixture] apply through the test tree, which can't be rebuilt from here.
            foreach (Type type in types)
            {
                if (HasAttributeNamed(type.CustomAttributes, SetUpFixtureAttribute) && GetActions(type, true).Count > 0) return;
            }

            const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
            foreach (Type type in types)
            {
                if (type.ContainsGenericParameters) continue;

                List<IOuterUnityTestAction> typeActions = null;
                foreach (MethodInfo method in type.GetMethods(Flags))
                {
                    if (!IsTest(method) || cache.ContainsKey(method)) continue;

                    var actions = new List<IOuterUnityTestAction> { new YieldAction() };
                    if (readsClassActions)
                    {
                        typeActions = typeActions ?? GetActions(type, true);
                        actions.AddRange(typeActions);
                    }
                    actions.AddRange(GetActions(method, readsClassActions));
                    cache[method] = actions;
                    Installed.Add(method);
                }
            }
        }

        private static bool IsTest(MethodInfo method)
        {
            foreach (CustomAttributeData attribute in method.CustomAttributes)
            {
                if (TestAttributes.Contains(attribute.AttributeType.Name)) return true;
            }
            return false;
        }

        private static bool HasAttributeNamed(IEnumerable<CustomAttributeData> attributes, string name)
        {
            foreach (CustomAttributeData attribute in attributes)
            {
                if (attribute.AttributeType.Name == name) return true;
            }
            return false;
        }

        // Older Test Frameworks look up actions from the method alone, while newer ones take the test and
        // also read its classes. Copying the wrong set would change which actions a project runs.
        private static bool ReadsClassActions()
        {
            const BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.FlattenHierarchy;
            foreach (MethodInfo method in typeof(IOuterUnityTestAction).Assembly.GetType(CommandType).GetMethods(Flags))
            {
                if (method.Name != "GetTestActions") continue;
                ParameterInfo[] parameters = method.GetParameters();
                if (parameters.Length == 2 && parameters[1].ParameterType == typeof(ITest)) return true;
            }
            return false;
        }

        private static List<IOuterUnityTestAction> GetActions(MemberInfo member, bool inherit)
        {
            var actions = new List<IOuterUnityTestAction>();
            foreach (object attribute in member.GetCustomAttributes(inherit))
            {
                if (attribute is IOuterUnityTestAction action) actions.Add(action);
            }
            return actions;
        }
    }
}
