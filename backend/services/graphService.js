const { GoogleGenAI } = require("@google/genai");
const Concept = require("../models/Concept");
const Edge = require("../models/Edge");
const DocumentEdge = require("../models/DocumentEdge");

const ai = new GoogleGenAI({});

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONCEPT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────
const extractConcepts = async (content, fileType) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `You are a knowledge graph builder. Analyze the following text from a ${fileType} document.

Extract 5-12 key concepts. For each concept provide:
- name: lowercase normalized identifier (no spaces, use hyphens e.g. "machine-learning")
- label: human readable label e.g. "Machine Learning"
- domain: the broader subject area this belongs to (e.g. "OOP", "Web Development", "Data Structures", "Machine Learning", "Mathematics", "History", etc.)
- type: one of [principle, technology, tool, person, event, theory, general]

Also extract up to 4 key RELATIONSHIPS between the concepts you found, each as:
- from: concept name
- to: concept name
- relationType: one of [IS-A, DEPENDS-ON, PART-OF, RELATED-TO, CONTRASTS-WITH, USES]

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "concepts": [
    { "name": "inheritance", "label": "Inheritance", "domain": "OOP", "type": "principle" }
  ],
  "relationships": [
    { "from": "inheritance", "to": "polymorphism", "relationType": "RELATED-TO" }
  ]
}

Text to analyze (first 4000 chars):
${content.substring(0, 4000)}`,
    });

    const raw = response.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return {
      concepts: parsed.concepts || [],
      relationships: parsed.relationships || [],
    };
  } catch (err) {
    console.error("Concept extraction error:", err.message);
    return { concepts: [], relationships: [] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. EMBEDDING GENERATION
// ─────────────────────────────────────────────────────────────────────────────
const getEmbedding = async (text) => {
  try {
    const response = await ai.models.embedContent({
      model: "embedding-001",
      contents: text,
    });
    return response.embeddings?.[0]?.values || [];
  } catch (err) {
    console.error("Embedding error:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. COSINE SIMILARITY
// ─────────────────────────────────────────────────────────────────────────────
const cosineSimilarity = (a, b) => {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. JACCARD SIMILARITY
//    Measures concept overlap between two sets.
//    0 = nothing in common, 1 = identical.
//    Formula: |intersection| / |union|
// ─────────────────────────────────────────────────────────────────────────────
const jaccardSimilarity = (setA, setB) => {
  if (!setA.length || !setB.length) return 0;
  const a = new Set(setA);
  const b = new Set(setB);
  const intersection = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return intersection.length / union.size;
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. LINK DOCUMENTS TO EACH OTHER
//    Compares new document's concepts against all existing docs for the user.
//    Creates a DocumentEdge when two files share enough concepts.
//
//    Thresholds (tune these to your liking):
//      MIN_SHARED_CONCEPTS — raw count of shared concept names
//      MIN_SIMILARITY      — Jaccard score (0–1)
//    A document pair only needs to pass ONE of these two thresholds.
// ─────────────────────────────────────────────────────────────────────────────
const MIN_SHARED_CONCEPTS = 2;
const MIN_SIMILARITY = 0.15;

const linkDocuments = async (userId, newDocId, newDocConcepts, Document) => {
  try {
    if (!newDocConcepts.length) return;

    const newConceptNames = newDocConcepts.map((c) => c.name);

    // All other docs for this user that have at least one concept
    const otherDocs = await Document.find({
      user: userId,
      _id: { $ne: newDocId },
      "concepts.0": { $exists: true },
    }).lean();

    for (const otherDoc of otherDocs) {
      const otherConceptNames = (otherDoc.concepts || []).map((c) => c.name);

      const newSet = new Set(newConceptNames);
      const sharedConcepts = otherConceptNames.filter((n) => newSet.has(n));
      const similarity = jaccardSimilarity(newConceptNames, otherConceptNames);

      // Skip pairs with too little in common
      if (
        sharedConcepts.length < MIN_SHARED_CONCEPTS &&
        similarity < MIN_SIMILARITY
      ) {
        continue;
      }

      // Find the most common domain among shared concepts
      const newDomainMap = new Map(
        newDocConcepts.map((c) => [c.name, c.domain]),
      );
      const otherDomainMap = new Map(
        (otherDoc.concepts || []).map((c) => [c.name, c.domain]),
      );
      const domainCounts = {};
      sharedConcepts.forEach((name) => {
        const d = newDomainMap.get(name) || otherDomainMap.get(name);
        if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
      });
      const sharedDomain =
        Object.keys(domainCounts).length > 0
          ? Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0][0]
          : null;

      // Sort IDs so docA < docB — guarantees the compound index stays unique
      const [docA, docB] = [
        newDocId.toString(),
        otherDoc._id.toString(),
      ].sort();

      await DocumentEdge.findOneAndUpdate(
        { user: userId, docA, docB },
        {
          $set: {
            sharedConcepts,
            sharedConceptCount: sharedConcepts.length,
            similarity: parseFloat(similarity.toFixed(3)),
            sharedDomain,
          },
        },
        { upsert: true, new: true },
      );
    }
  } catch (err) {
    console.error("Document linking error:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. BUILD / UPDATE GRAPH
//    Upserts concept nodes → builds concept edges → links documents together
// ─────────────────────────────────────────────────────────────────────────────
const buildGraph = async (
  userId,
  documentId,
  concepts,
  relationships,
  Document,
) => {
  try {
    const conceptNames = concepts.map((c) => c.name);

    // Upsert concept nodes
    for (const concept of concepts) {
      const embedding = await getEmbedding(concept.label);

      await Concept.findOneAndUpdate(
        { user: userId, name: concept.name },
        {
          $set: {
            label: concept.label,
            domain: concept.domain,
            type: concept.type,
            lastSeen: new Date(),
            ...(embedding.length ? { embedding } : {}),
          },
          $addToSet: { documentIds: documentId },
          $setOnInsert: { firstSeen: new Date() },
        },
        { upsert: true, new: true },
      );
    }

    // Build concept-to-concept edges from co-occurrence
    for (let i = 0; i < conceptNames.length; i++) {
      for (let j = i + 1; j < conceptNames.length; j++) {
        const [from, to] = [conceptNames[i], conceptNames[j]].sort();

        await Edge.findOneAndUpdate(
          { user: userId, from, to },
          {
            $inc: { strength: 1 },
            $addToSet: { sharedDocuments: documentId },
          },
          { upsert: true, new: true },
        );
      }
    }

    // Set explicit relation types from Gemini
    for (const rel of relationships) {
      const [from, to] = [rel.from, rel.to].sort();
      await Edge.findOneAndUpdate(
        { user: userId, from, to },
        { $set: { relationType: rel.relationType } },
        { upsert: false },
      );
    }

    // Link this document to similar existing documents
    if (Document) {
      await linkDocuments(userId, documentId, concepts, Document);
    }
  } catch (err) {
    console.error("Graph build error:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. SEMANTIC SEARCH
// ─────────────────────────────────────────────────────────────────────────────
const semanticSearch = async (userId, query, Document) => {
  const q = query.trim().toLowerCase();

  const directConcepts = await Concept.find({
    user: userId,
    $or: [
      { name: { $regex: q, $options: "i" } },
      { label: { $regex: q, $options: "i" } },
      { domain: { $regex: q, $options: "i" } },
    ],
  }).lean();

  const directNames = directConcepts.map((c) => c.name);

  const edges = await Edge.find({
    user: userId,
    $or: [{ from: { $in: directNames } }, { to: { $in: directNames } }],
  }).lean();

  const neighborNames = new Set(directNames);
  edges.forEach((e) => {
    neighborNames.add(e.from);
    neighborNames.add(e.to);
  });

  if (directConcepts.length < 3) {
    try {
      const queryEmbedding = await getEmbedding(query);
      if (queryEmbedding.length) {
        const allConcepts = await Concept.find({ user: userId }).lean();
        allConcepts.forEach((c) => {
          if (c.embedding?.length) {
            const sim = cosineSimilarity(queryEmbedding, c.embedding);
            if (sim > 0.75) neighborNames.add(c.name);
          }
        });
      }
    } catch (e) {
      // best-effort
    }
  }

  const allDocs = await Document.find({ user: userId }).lean();

  const scored = allDocs.map((doc) => {
    const docConcepts = (doc.concepts || []).map((c) => c.name);
    const directHits = docConcepts.filter((n) =>
      directNames.includes(n),
    ).length;
    const neighborHits = docConcepts.filter((n) => neighborNames.has(n)).length;
    const titleMatch = doc.title.toLowerCase().includes(q) ? 3 : 0;
    const score = directHits * 5 + neighborHits * 2 + titleMatch;
    return { doc, score, directHits, neighborHits };
  });

  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    directConcepts,
    expandedConceptNames: [...neighborNames],
    results: ranked.map((s) => ({
      ...s.doc,
      _score: s.score,
      _matchType: s.directHits > 0 ? "direct" : "related",
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. GET FULL GRAPH — concept nodes + document nodes + both edge types
// ─────────────────────────────────────────────────────────────────────────────
const getFullGraph = async (userId, Document) => {
  const [conceptNodes, conceptEdges, docEdges] = await Promise.all([
    Concept.find({ user: userId }).lean(),
    Edge.find({ user: userId }).lean(),
    DocumentEdge.find({ user: userId }).sort({ similarity: -1 }).lean(),
  ]);

  // Fetch document nodes that participate in at least one document edge
  const docIdsInGraph = new Set();
  docEdges.forEach((e) => {
    docIdsInGraph.add(e.docA.toString());
    docIdsInGraph.add(e.docB.toString());
  });

  let documentNodes = [];
  if (docIdsInGraph.size > 0 && Document) {
    const docs = await Document.find({
      user: userId,
      _id: { $in: [...docIdsInGraph] },
    })
      .select("title type summary createdAt concepts")
      .lean();

    documentNodes = docs.map((d) => ({
      id: d._id.toString(),
      label: d.title,
      nodeType: "document",
      docType: d.type,
      domain: d.concepts?.[0]?.domain || "General",
      summary: d.summary,
      createdAt: d.createdAt,
    }));
  }

  return {
    conceptNodes: conceptNodes.map((c) => ({
      id: c.name,
      label: c.label,
      domain: c.domain,
      type: c.type,
      nodeType: "concept",
      docCount: c.documentIds.length,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
    })),
    conceptEdges: conceptEdges.map((e) => ({
      from: e.from,
      to: e.to,
      strength: e.strength,
      relationType: e.relationType,
    })),
    documentNodes,
    documentEdges: docEdges.map((e) => ({
      from: e.docA.toString(),
      to: e.docB.toString(),
      sharedConcepts: e.sharedConcepts,
      sharedConceptCount: e.sharedConceptCount,
      similarity: e.similarity,
      sharedDomain: e.sharedDomain,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. GET SUBGRAPH — BFS from a concept, includes related document nodes
// ─────────────────────────────────────────────────────────────────────────────
const getSubgraph = async (userId, conceptName, depth = 2, Document) => {
  const visited = new Set();
  const queue = [conceptName.toLowerCase()];
  const resultConceptNodes = [];
  const resultConceptEdges = [];

  let hop = 0;
  while (queue.length && hop < depth) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const concept = await Concept.findOne({
      user: userId,
      name: current,
    }).lean();
    if (concept) {
      resultConceptNodes.push({
        id: concept.name,
        label: concept.label,
        domain: concept.domain,
        type: concept.type,
        nodeType: "concept",
        docCount: concept.documentIds.length,
        firstSeen: concept.firstSeen,
        lastSeen: concept.lastSeen,
      });
    }

    const connectedEdges = await Edge.find({
      user: userId,
      $or: [{ from: current }, { to: current }],
    }).lean();

    connectedEdges.forEach((e) => {
      resultConceptEdges.push({
        from: e.from,
        to: e.to,
        strength: e.strength,
        relationType: e.relationType,
      });
      const neighbor = e.from === current ? e.to : e.from;
      if (!visited.has(neighbor)) queue.push(neighbor);
    });

    hop++;
  }

  // Deduplicate edges
  const edgeMap = new Map();
  resultConceptEdges.forEach((e) => {
    const key = [e.from, e.to].sort().join("|||");
    if (!edgeMap.has(key) || edgeMap.get(key).strength < e.strength) {
      edgeMap.set(key, e);
    }
  });

  // Find docs containing any concept in the subgraph, + their doc-doc edges
  const subgraphConceptNames = resultConceptNodes.map((n) => n.id);
  let documentNodes = [];
  let documentEdges = [];

  if (Document && subgraphConceptNames.length > 0) {
    const relatedDocs = await Document.find({
      user: userId,
      "concepts.name": { $in: subgraphConceptNames },
    })
      .select("title type summary createdAt concepts")
      .lean();

    documentNodes = relatedDocs.map((d) => ({
      id: d._id.toString(),
      label: d.title,
      nodeType: "document",
      docType: d.type,
      domain: d.concepts?.[0]?.domain || "General",
      summary: d.summary,
      createdAt: d.createdAt,
    }));

    const relatedDocIds = relatedDocs.map((d) => d._id.toString());
    const relDocEdges = await DocumentEdge.find({
      user: userId,
      $or: [{ docA: { $in: relatedDocIds } }, { docB: { $in: relatedDocIds } }],
    }).lean();

    documentEdges = relDocEdges.map((e) => ({
      from: e.docA.toString(),
      to: e.docB.toString(),
      sharedConcepts: e.sharedConcepts,
      sharedConceptCount: e.sharedConceptCount,
      similarity: e.similarity,
      sharedDomain: e.sharedDomain,
    }));
  }

  return {
    conceptNodes: resultConceptNodes,
    conceptEdges: [...edgeMap.values()],
    documentNodes,
    documentEdges,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. GET DOCUMENT CONNECTIONS
//     All documents connected to a specific document — for a "related files"
//     sidebar on a document detail page.
// ─────────────────────────────────────────────────────────────────────────────
const getDocumentConnections = async (userId, docId, Document) => {
  const docIdStr = docId.toString();

  const edges = await DocumentEdge.find({
    user: userId,
    $or: [{ docA: docId }, { docB: docId }],
  })
    .sort({ similarity: -1 })
    .lean();

  const connectedIds = edges.map((e) =>
    e.docA.toString() === docIdStr ? e.docB : e.docA,
  );

  const connectedDocs = await Document.find({
    user: userId,
    _id: { $in: connectedIds },
  })
    .select("title type summary createdAt concepts")
    .lean();

  return connectedDocs.map((doc) => {
    const edge = edges.find(
      (e) =>
        e.docA.toString() === doc._id.toString() ||
        e.docB.toString() === doc._id.toString(),
    );
    return {
      ...doc,
      sharedConcepts: edge?.sharedConcepts || [],
      sharedConceptCount: edge?.sharedConceptCount || 0,
      similarity: edge?.similarity || 0,
      sharedDomain: edge?.sharedDomain || null,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. CLEANUP on document delete
// ─────────────────────────────────────────────────────────────────────────────
const removeDocumentFromGraph = async (userId, documentId, conceptNames) => {
  try {
    await Concept.updateMany(
      { user: userId, name: { $in: conceptNames } },
      { $pull: { documentIds: documentId } },
    );
    await Concept.deleteMany({ user: userId, documentIds: { $size: 0 } });

    await Edge.updateMany(
      { user: userId, sharedDocuments: documentId },
      {
        $pull: { sharedDocuments: documentId },
        $inc: { strength: -1 },
      },
    );
    await Edge.deleteMany({ user: userId, strength: { $lte: 0 } });

    // Remove all document-level edges involving this document
    await DocumentEdge.deleteMany({
      user: userId,
      $or: [{ docA: documentId }, { docB: documentId }],
    });
  } catch (err) {
    console.error("Graph cleanup error:", err.message);
  }
};

module.exports = {
  extractConcepts,
  buildGraph,
  semanticSearch,
  getSubgraph,
  getFullGraph,
  getDocumentConnections,
  removeDocumentFromGraph,
};
