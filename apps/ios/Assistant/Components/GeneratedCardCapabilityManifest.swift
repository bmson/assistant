// Generated from packages/persistence/src/card-capabilities.ts. Do not edit by hand.
import Foundation

enum GeneratedCardCapabilityManifest {
    static let contract: [String: Any] = {
        let data = Data(#"""
{
  "version": 1,
  "limits": {
    "spec": {
      "facts": {
        "min": 1,
        "max": 40
      },
      "blocks": {
        "min": 1,
        "max": 12
      },
      "actions": {
        "max": 6
      },
      "title": {
        "max": 100
      },
      "subtitle": {
        "max": 160
      },
      "accessibilityLabel": {
        "max": 200
      },
      "sourceLabel": {
        "max": 80
      },
      "icons": [
        "ticket",
        "plane",
        "sport",
        "package",
        "calendar",
        "map",
        "music",
        "star",
        "train",
        "car",
        "hotel",
        "food",
        "money",
        "health",
        "weather",
        "checklist",
        "generic"
      ],
      "accents": [
        "mint",
        "sky",
        "amber",
        "rose",
        "violet",
        "slate"
      ]
    },
    "fact": {
      "idPattern": "^[a-z0-9_-]{1,40}$",
      "value": {
        "max": 500
      },
      "label": {
        "max": 60
      },
      "source": {
        "max": 80
      }
    },
    "action": {
      "idPattern": "^[a-z0-9_-]{1,40}$",
      "types": [
        "open_url",
        "copy_value",
        "reveal_sensitive",
        "refresh",
        "ask_assistant",
        "add_to_calendar",
        "directions"
      ],
      "label": {
        "max": 40
      },
      "prompt": {
        "max": 160
      }
    },
    "section": {
      "depth": 0,
      "title": {
        "max": 60
      },
      "blocks": {
        "min": 1,
        "max": 6
      }
    },
    "table": {
      "columns": {
        "min": 2,
        "max": 4,
        "titleMax": 60
      },
      "rows": {
        "min": 1,
        "max": 8
      }
    },
    "chart": {
      "points": {
        "min": 2,
        "max": 12
      }
    }
  },
  "rules": {
    "hero": {
      "required": [
        "titleFact"
      ],
      "optional": [
        "subtitleFact"
      ]
    },
    "facts": {
      "ids": {
        "field": "factIds",
        "min": 1,
        "max": 8
      }
    },
    "timeline": {
      "ids": {
        "field": "factIds",
        "min": 1,
        "max": 8
      }
    },
    "score": {
      "required": [
        "leftLabelFact",
        "leftValueFact",
        "rightLabelFact",
        "rightValueFact"
      ],
      "optional": [
        "statusFact"
      ]
    },
    "code": {
      "required": [
        "valueFact"
      ],
      "enums": {
        "format": [
          "qr",
          "barcode",
          "text"
        ]
      }
    },
    "image": {
      "required": [
        "urlFact"
      ],
      "optional": [
        "altFact"
      ]
    },
    "note": {
      "required": [
        "factId"
      ]
    },
    "metrics": {
      "ids": {
        "field": "factIds",
        "min": 2,
        "max": 4
      }
    },
    "journey": {
      "required": [
        "fromFact",
        "toFact"
      ],
      "optional": [
        "departFact",
        "arriveFact",
        "statusFact",
        "durationFact"
      ],
      "enums": {
        "mode": [
          "flight",
          "train",
          "bus",
          "car",
          "ferry",
          "walk"
        ]
      }
    },
    "progress": {
      "required": [
        "valueFact"
      ],
      "optional": [
        "totalFact",
        "labelFact"
      ]
    },
    "stages": {
      "required": [
        "currentFact"
      ],
      "ids": {
        "field": "factIds",
        "min": 2,
        "max": 8
      }
    },
    "countdown": {
      "required": [
        "dateFact"
      ],
      "optional": [
        "labelFact"
      ]
    },
    "table": {},
    "chart": {
      "enums": {
        "kind": [
          "bar",
          "line"
        ]
      }
    },
    "checklist": {
      "ids": {
        "field": "factIds",
        "min": 1,
        "max": 12
      }
    },
    "map": {
      "ids": {
        "field": "placeFactIds",
        "min": 1,
        "max": 6
      }
    }
  },
  "surfaces": {
    "webShellOnly": [
      "map",
      "codeNonText"
    ]
  }
}
"""#.utf8)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }()
}
