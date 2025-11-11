import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Button, StyleSheet, Platform } from "react-native";
import { VrmSpeaker } from "../src/VrmSpeaker";

export default function HomeScreen() {
  const [text, setText] = useState("Hello, I am your VRoid avatar.");

  const handleSpeak = () => {
    if (Platform.OS === "web") {
      window.dispatchEvent(
        new CustomEvent("vrm-speak", {
          detail: { text }
        })
      );
    } else {
      // ネイティブ対応したくなったらここに実装
      console.log("Speech is only implemented for web for now.");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>VRoid Talk (Web)</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Type something your avatar will say"
        multiline
      />
      <View style={styles.buttonWrap}>
        <Button title="Speak" onPress={handleSpeak} />
      </View>
      {/* WebでのみVRMを描画 */}
      <VrmSpeaker />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 16,
    backgroundColor: "#111",
    alignItems: "stretch",
    justifyContent: "flex-start"
  },
  title: {
    fontSize: 24,
    color: "#fff",
    fontWeight: "bold"
  },
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: "#666",
    color: "#fff",
    padding: 8,
    borderRadius: 8
  },
  buttonWrap: {
    alignSelf: "flex-start",
    width: 120
  }
});
